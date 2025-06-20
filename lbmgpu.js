(async () => {
  if (!navigator.gpu) {
    document.body.textContent = "WebGPU is not supported in this browser.";
    return;
  }
  const ui = {
    panel: document.getElementById("controls"),
    collapse: document.getElementById("toggleSettings"),
    inflow: document.getElementById("velocity"),
    vizSelect: document.getElementById("visualization"),
    velocitySlider: document.getElementById("velocity"),
    velocityValue: document.getElementById("velocityValue"),
    reInit: document.getElementById("reinit"),
    viscositySlider: document.getElementById("viscosity"),
    viscosityValue: document.getElementById("viscosityValue"),
    simSpeedSlider: document.getElementById("simSpeed"),
    simSpeedValue: document.getElementById("simSpeedValue"),
    simResSlider: document.getElementById("simRes"),
    simResValue: document.getElementById("simResValue"),
    barrierUpload: document.getElementById("barrierUpload"),
    thresholdSlider: document.getElementById("threshold"),
    thresholdValue: document.getElementById("thresholdValue"),
    barrierApply: document.getElementById("applyBarrierImage"),
    imageScale: document.getElementById("imageScale"),
    barrierInvert: document.getElementById("barrierInvert"),
    barrierClear: document.getElementById("clearBarriers"),
    noSlip: document.getElementById("noSlip"),
  };

  let scale = 1;

  let width = window.innerWidth;
  let height = window.innerHeight;

  // ----- Simulation Parameters -----
  let gridWidth = Math.floor(width / scale); //1024;
  let gridHeight = Math.floor(height / scale);
  let numCells = gridWidth * gridHeight;
  const numDirs = 9; // D2Q9
  let tau = 0.6;   // Relaxation time

  let speed = 1;

  // D2Q9 weights and lattice vectors.
  const weights = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
  const ex = [0, 1, 0, -1, 0, 1, -1, -1, 1];
  const ey = [0, 0, 1, 0, -1, 1, 1, -1, -1];

  // ----- WebGPU Setup -----
  const canvas = document.getElementById("canvas");
  canvas.width = width;
  canvas.height = height;
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  const swapChainFormat = "bgra8unorm";
  context.configure({
    device: device,
    format: swapChainFormat,
  });

  // ----- Buffers -----
  const stateBufferSize = numCells * numDirs * Float32Array.BYTES_PER_ELEMENT;
  let stateBuffer0 = device.createBuffer({
    size: stateBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    label: "state0"
  });
  let stateBuffer1 = device.createBuffer({
    size: stateBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    label: "state1"
  });
  const postCollisionBuffer = device.createBuffer({
    size: stateBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    label: "postCollision"
  });
  const barrierBufferSize = numCells * Int32Array.BYTES_PER_ELEMENT;
  const barrierBuffer = device.createBuffer({
    size: barrierBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "barrier"
  });

  // ----- Uniform Buffer -----
  // Uniforms now include an extra "inflow" field (rightward flow velocity)
  // Layout: [gridWidth, gridHeight, tau, vizMode, inflow, noSlip]
  let inflow = parseFloat(ui.inflow.value);
  const uniformData = new Float32Array([gridWidth, gridHeight, tau, 2, inflow, 1]);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "uniform"
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData.buffer);

  // ----- Simulation Initialization -----
  // Initialize with uniform rightward flow (density=1, velocity=(inflow,0))
  function initializeState(rightwardFlow) {
    const initialState = new Float32Array(numCells * numDirs);
    const density = 1.0;
    const u0 = rightwardFlow;
    const u1 = 0.0;
    const uSq = u0 * u0 + u1 * u1;
    for (let i = 0; i < numCells; i++) {
      for (let d = 0; d < numDirs; d++) {
        const edotu = ex[d] * u0 + ey[d] * u1;
        const feq = weights[d] * density * (1 + 3 * edotu + 4.5 * edotu * edotu - 1.5 * uSq);
        initialState[i * numDirs + d] = feq;
      }
    }
    device.queue.writeBuffer(stateBuffer0, 0, initialState.buffer);
    device.queue.writeBuffer(stateBuffer1, 0, initialState.buffer);
  }
  initializeState(inflow);

  // Initially, no barriers.
  const barrierInit = new Int32Array(numCells);
  device.queue.writeBuffer(barrierBuffer, 0, barrierInit.buffer);

  // ----- Collision Compute Shader -----
  // Note: Uniforms now include "inflow", though collision pass doesn't use it.
  const collisionShaderCode = `
    struct Uniforms {
      gridWidth: f32,
      gridHeight: f32,
      tau: f32,
      vizMode: f32,
      inflow: f32,
      noSlip: f32,
    };
    @group(0) @binding(0) var<storage, read> stateIn: array<f32>;
    @group(0) @binding(1) var<storage, read_write> postCollision: array<f32>;
    @group(0) @binding(2) var<storage, read> barriers: array<i32>;
    @group(0) @binding(3) var<uniform> uniforms: Uniforms;

    const numDirs: u32 = 9u;
    const weights: array<f32, 9> = array<f32, 9>(4.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0);
    const ex: array<i32, 9> = array<i32, 9>(0, 1, 0, -1, 0, 1, -1, -1, 1);
    const ey: array<i32, 9> = array<i32, 9>(0, 0, 1, 0, -1, 1, 1, -1, -1);
    const opp: array<u32, 9> = array<u32, 9>(0, 3, 4, 1, 2, 7, 8, 5, 6);

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      let x = i32(global_id.x);
      let y = i32(global_id.y);
      let width = i32(uniforms.gridWidth);
      let height = i32(uniforms.gridHeight);
      if (x >= width || y >= height) { return; }
      let index = y * width + x;
      let isBarrier = barriers[index];

      var density: f32 = 0.0;
      var ux: f32 = 0.0;
      var uy: f32 = 0.0;
      for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
        let idx = index * i32(numDirs) + i32(d);
        let f = stateIn[idx];
        density = density + f;
        ux = ux + f * f32(ex[d]);
        uy = uy + f * f32(ey[d]);
      }
      if (density > 0.0) {
        ux = ux / density;
        uy = uy / density;
      }
      
      for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
        let idx = index * i32(numDirs) + i32(d);
        let edotu = f32(ex[d]) * ux + f32(ey[d]) * uy;
        let uSq = ux * ux + uy * uy;
        let feq = weights[d] * density * (1.0 + 3.0 * edotu + 4.5 * edotu * edotu - 1.5 * uSq);
        var f_post = stateIn[idx] - (stateIn[idx] - feq) / uniforms.tau;
        if (isBarrier == 1) {
          let oppIdx = index * i32(numDirs) + i32(opp[d]);
          f_post = stateIn[oppIdx];
        }
        postCollision[idx] = f_post;
      }
    }
  `;
  const collisionModule = device.createShaderModule({ code: collisionShaderCode, label: "collisionModule" });
  const collisionPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: collisionModule, entryPoint: 'main' },
    label: "collisionPipeline"
  });
  const collisionBindGroup = (stateBufferIn) => device.createBindGroup({
    layout: collisionPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBufferIn } },
      { binding: 1, resource: { buffer: postCollisionBuffer } },
      { binding: 2, resource: { buffer: barrierBuffer } },
      { binding: 3, resource: { buffer: uniformBuffer } },
    ],
    label: "collisionBindGroup"
  });

  // ----- Streaming Compute Shader -----
  // Now with non–periodic horizontal boundaries. For x-direction, if the neighbor is out of bounds,
  // the equilibrium distribution (with density=1, velocity=(inflow, 0)) is used.
  const streamingShaderCode = `
    struct Uniforms {
      gridWidth: f32,
      gridHeight: f32,
      tau: f32,
      vizMode: f32,
      inflow: f32,
      noSlip: f32,
    };
    @group(0) @binding(0) var<storage, read> postCollision: array<f32>;
    @group(0) @binding(1) var<storage, read_write> stateOut: array<f32>;
    @group(0) @binding(2) var<uniform> uniforms: Uniforms;

    const numDirs: u32 = 9u;
    const weights: array<f32, 9> = array<f32, 9>(4.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0);
    const ex: array<i32, 9> = array<i32, 9>(0, 1, 0, -1, 0, 1, -1, -1, 1);
    const ey: array<i32, 9> = array<i32, 9>(0, 0, 1, 0, -1, 1, 1, -1, -1);

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      let x = i32(global_id.x);
      let y = i32(global_id.y);
      let width = i32(uniforms.gridWidth);
      let height = i32(uniforms.gridHeight);
      if (x >= width || y >= height) { return; }
      let index = y * width + x;
      for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
        let rawSrcX = x - i32(ex[d]);
        let rawSrcY = y - i32(ey[d]);
        var useEquilibrium = false;
        var useBounceBack = false;
        var useOutflow = false;
        var srcIdx: i32 = 0;
        if (rawSrcX < 0) {
          useEquilibrium = true;
        } else if (rawSrcX >= width) {
          useEquilibrium = true;
          // useOutflow = true;
        } else if (rawSrcY < 0 || rawSrcY >= height) {
          if (uniforms.noSlip > 0.5) {
            useBounceBack = true;
          } else {
            useEquilibrium = true;
          }
        } else {
          let srcX = rawSrcX;
          let srcY = rawSrcY;
          let srcIndex = srcY * width + srcX;
          srcIdx = srcIndex * i32(numDirs) + i32(d);
        }
        let targetIdx = index * i32(numDirs) + i32(d);
        if (useEquilibrium) {
          let U = uniforms.inflow;
          let edotu = f32(ex[d]) * U; // inflow is only in x, so uy=0.
          let feq = weights[d] * 1.0 * (1.0 + 3.0 * edotu + 4.5 * edotu * edotu - 1.5 * (U * U));
          stateOut[targetIdx] = feq;
        } else if (useBounceBack) {
          // Bounce-back: use the opposite direction value from the same cell.
          let opp: array<u32, 9> = array<u32, 9>(0, 3, 4, 1, 2, 7, 8, 5, 6);
          stateOut[targetIdx] = postCollision[index * i32(numDirs) + i32(opp[d])];
        } else if (useOutflow) {
          stateOut[targetIdx] = postCollision[index * i32(numDirs) + i32(d)];
        } else {
          stateOut[targetIdx] = postCollision[srcIdx];
        }
        stateOut[targetIdx] = min(max(1.e-5, stateOut[targetIdx]), 1);
      }
    }
  `;
  const streamingModule = device.createShaderModule({ code: streamingShaderCode, label: "streamingModule" });
  const streamingPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: streamingModule, entryPoint: 'main' },
    label: "streamingPipeline"
  });
  const streamingBindGroup = (stateBufferOut) => device.createBindGroup({
    layout: streamingPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: postCollisionBuffer } },
      { binding: 1, resource: { buffer: stateBufferOut } },
      { binding: 2, resource: { buffer: uniformBuffer } },
    ],
    label: "streamingBindGroup"
  });

  // ----- Render Pipeline (Visualization) -----
  // The render shader now also reads the barrier buffer and renders barriers in red.
  const renderShaderCode = `
    struct Uniforms {
      gridWidth: f32,
      gridHeight: f32,
      tau: f32,
      vizMode: f32,
      inflow: f32,
      noSlip: f32,
    };
    @group(0) @binding(0) var<storage, read> state: array<f32>;
    @group(0) @binding(1) var<uniform> uniforms: Uniforms;
    @group(0) @binding(2) var<storage, read> barriers: array<i32>;

    struct VertexOut {
      @builtin(position) position: vec4<f32>,
      @location(0) fragCoord: vec2<f32>,
    };

    @vertex
    fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
      var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0,  3.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0, -1.0),
      );
      var output: VertexOut;
      output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
      output.fragCoord = 0.5 * (pos[vertexIndex] + vec2<f32>(1.0)) * vec2<f32>(uniforms.gridWidth, uniforms.gridHeight);
      return output;
    }

    fn colorMap(value:f32) -> vec3<f32> {
      return vec3<f32>(value, 1.0 - abs(value - 0.5), 1.0 - value);
    }

    @fragment
    fn fs_main(@location(0) fragCoord: vec2<f32>) -> @location(0) vec4<f32> {
      let x = i32(fragCoord.x);
      let y = i32(fragCoord.y);
      let width = i32(uniforms.gridWidth);
      let index = y * width + x;
      
      // Render barriers
      if (barriers[index] == 1) {
        if (uniforms.vizMode < 1.5) {
          return vec4<f32>(0.0);
        } else {
          return vec4<f32>(1.0, 0.0, 0.0, 1.0);
        }
      }
      
      let numDirs: u32 = 9u;
      var density: f32 = 0.0;
      var ux: f32 = 0.0;
      var uy: f32 = 0.0;
      for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
        let f = state[index * i32(numDirs) + i32(d)];
        density = density + f;
        ux = ux + f * f32(array<i32,9>(0,1,0,-1,0,1,-1,-1,1)[d]);
        uy = uy + f * f32(array<i32,9>(0,0,1,0,-1,1,1,-1,-1)[d]);
      }
      if (density > 0.0) {
        ux = ux / density;
        uy = uy / density;
      }
      let speed = sqrt(ux * ux + uy * uy);
      //let speedScaled = speed * 0.5;
      
      var dudy: f32 = 0.0;
      var dudx: f32 = 0.0;
      if (x > 0 && x < width - 1) {
        var uyL: f32 = 0.0;
        var uyR: f32 = 0.0;
        let indexL = y * width + (x - 1);
        let indexR = y * width + (x + 1);
        for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
          uyL = uyL + state[indexL * i32(numDirs) + i32(d)] * f32(array<i32,9>(0,0,1,0,-1,1,1,-1,-1)[d]);
          uyR = uyR + state[indexR * i32(numDirs) + i32(d)] * f32(array<i32,9>(0,0,1,0,-1,1,1,-1,-1)[d]);
        }
        dudy = (uyR - uyL) * 0.5;
      }
      if (y > 0 && y < i32(uniforms.gridHeight) - 1) {
        var uxT: f32 = 0.0;
        var uxB: f32 = 0.0;
        let indexT = (y - 1) * width + x;
        let indexB = (y + 1) * width + x;
        for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
          uxT = uxT + state[indexT * i32(numDirs) + i32(d)] * f32(array<i32,9>(0,1,0,-1,0,1,-1,-1,1)[d]);
          uxB = uxB + state[indexB * i32(numDirs) + i32(d)] * f32(array<i32,9>(0,1,0,-1,0,1,-1,-1,1)[d]);
        }
        dudx = (uxB - uxT) * 0.5;
      }
      let curl = (dudy - dudx) * 50.0;
      
      var color: vec3<f32>;
      if (uniforms.vizMode < 0.5) {
        color = colorMap(density * 1.5 - 1.0); // 3 * (density/2 - 0.5) + 0.5
      } else if (uniforms.vizMode < 1.5) {
        color = colorMap(2.0 * speed - uniforms.inflow);
      } else if (uniforms.vizMode < 2.5) {
        color = vec3<f32>(abs(curl));
      } else {
        // Schlieren mode: compute gradient of density.
        var densityL: f32 = 0.0;
        var densityR: f32 = 0.0;
        var densityT: f32 = 0.0;
        var densityB: f32 = 0.0;
        if (x > 0) {
          let indexL = y * width + (x - 1);
          for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
            densityL += state[indexL * i32(numDirs) + i32(d)];
          }
        } else { densityL = density; }
        if (x < width - 1) {
          let indexR = y * width + (x + 1);
          for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
            densityR += state[indexR * i32(numDirs) + i32(d)];
          }
        } else { densityR = density; }
        if (y > 0) {
          let indexT = (y - 1) * width + x;
          for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
            densityT += state[indexT * i32(numDirs) + i32(d)];
          }
        } else { densityT = density; }
        if (y < i32(uniforms.gridHeight) - 1) {
          let indexB = (y + 1) * width + x;
          for (var d: u32 = 0u; d < numDirs; d = d + 1u) {
            densityB += state[indexB * i32(numDirs) + i32(d)];
          }
        } else { densityB = density; }
        let dDensityX = (densityR - densityL) * 0.5;
        let dDensityY = (densityB - densityT) * 0.5;
        let gradDensity = sqrt(dDensityX * dDensityX + dDensityY * dDensityY);
        color = vec3<f32>(gradDensity * 100.0);
      }
      return vec4<f32>(color, 1.0);
    }
  `;
  const renderModule = device.createShaderModule({ code: renderShaderCode, label: "renderModule" });
  const renderPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: renderModule, entryPoint: 'vs_main' },
    fragment: { module: renderModule, entryPoint: 'fs_main', targets: [{ format: swapChainFormat }] },
    primitive: { topology: 'triangle-list' },
    label: "renderPipeline"
  });
  const renderBindGroup = (stateBufferForRender) => device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBufferForRender } },
      { binding: 1, resource: { buffer: uniformBuffer } },
      { binding: 2, resource: { buffer: barrierBuffer } },
    ],
    label: "renderBindGroup"
  });

  // ----- Visualization UI Control -----
  ui.vizSelect.addEventListener("change", () => {
    const mode = ui.vizSelect.value;
    const modeVal = mode === "density" ? 0 : mode === "speed" ? 1 : mode === "curl" ? 2 : 3;
    uniformData[3] = modeVal;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData.buffer);
  });

  // Rightward flow UI.
  ui.velocitySlider.addEventListener("input", () => {
    const v = parseFloat(ui.velocitySlider.value);
    ui.velocityValue.textContent = v.toFixed(2);
    // Update uniform inflow parameter as well.
    uniformData[4] = v;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData.buffer);
  });
  ui.reInit.addEventListener("click", () => {
    const v = parseFloat(ui.velocitySlider.value);
    initializeState(v);
  });

  // Viscosity
  ui.viscositySlider.addEventListener("input", () => {
    const v = parseFloat(ui.viscositySlider.value);
    ui.viscosityValue.textContent = v.toFixed(2);
    tau = (3 * v + 0.5);
    uniformData[2] = tau;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData.buffer);
  });

  // Simulation speed
  ui.simSpeedSlider.addEventListener("input", () => {
    const v = parseInt(ui.simSpeedSlider.value);
    ui.simSpeedValue.textContent = v;
    speed = v;
  });

  // Simulation resolution
  ui.simResSlider.addEventListener("input", () => {
    scale = parseInt(ui.simResSlider.value);
    ui.simResValue.textContent = scale;
    refreshGrid();
  });

  // Refresh the grid, only works for decreasing size due to buffer sizes
  function refreshGrid() {
    gridWidth = Math.floor(width / scale);
    gridHeight = Math.floor(height / scale);
    numCells = gridWidth * gridHeight;
    uniformData[0] = gridWidth;
    uniformData[1] = gridHeight;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData.buffer);
    initializeState(parseFloat(ui.velocitySlider.value));
    clearBarriers();
  }

  // No-slip condition toggle
  ui.noSlip.addEventListener("click", () => {
    uniformData[5] = ui.noSlip.checked ? 1 : 0;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData.buffer);
  });

  // ----- Barrier Setting (Mouse Click) -----
  // Flip the y coordinate so that clicking maps directly to simulation coordinates.
  const barrierArray = new Int32Array(numCells);
  let isDrawing = false;
  let erase = null;
  let lastPos = null;

  canvas.addEventListener("mousedown", (event) => {
    isDrawing = true;
    lastPos = null;
    placeBarrier(event);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!isDrawing) return;
    event.getCoalescedEvents().forEach((e) => placeBarrier(e));
  });

  canvas.addEventListener("mouseup", () => {
    isDrawing = false;
    erase = null;
    lastPos = null;
  });

  function placeBarrier(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (scale * rect.width);
    const scaleY = canvas.height / (scale * rect.height);
    const x = Math.floor((event.clientX - rect.left) * scaleX);
    const y = gridHeight - 1 - Math.floor((event.clientY - rect.top) * scaleY);

    // Interpolate from lastPos to (x, y)
    if (lastPos) {
      const dx = x - lastPos.x;
      const dy = y - lastPos.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.ceil(dist);
      for (let i = 1; i <= steps; i++) {
        const ix = Math.round(lastPos.x + dx * (i / steps));
        const iy = Math.round(lastPos.y + dy * (i / steps));
        placeBarrierAt(ix, iy);
      }
    } else {
      placeBarrierAt(x, y);
    }

    lastPos = { x, y };
  }

  function placeBarrierAt(x, y) {
    if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) return;
    const index = y * gridWidth + x;

    // Set erase mode based on first contact
    if (erase === null) {
      erase = barrierArray[index] === 0 ? 1 : 0;
    }

    barrierArray[index] = erase;

    device.queue.writeBuffer(
      barrierBuffer,
      index * Int32Array.BYTES_PER_ELEMENT,
      new Int32Array([barrierArray[index]])
    );
  }

  // ----- Barrier Image Upload & Processing -----
  ui.thresholdSlider.addEventListener("input", () => {
    const t = parseFloat(ui.thresholdSlider.value);
    ui.thresholdValue.textContent = t.toFixed(2);
  });
  ui.barrierApply.addEventListener("click", () => {
    if (!ui.barrierUpload.files || ui.barrierUpload.files.length === 0) return;
    clearBarriers();
    const file = ui.barrierUpload.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Get the UI scale factor.
        const uiScale = parseFloat(ui.imageScale.value);
        // Compute the maximum scale factor to fit the canvas.
        const fitScale = Math.min(gridWidth / img.width, gridHeight / img.height);
        // Final target size: original image scaled by fitScale and then by uiScale.
        const targetWidth = Math.round(img.width * fitScale * uiScale);
        const targetHeight = Math.round(img.height * fitScale * uiScale);
        // Create offscreen canvas to draw the scaled image.
        const offCanvas = document.createElement("canvas");
        offCanvas.width = targetWidth;
        offCanvas.height = targetHeight;
        const offCtx = offCanvas.getContext("2d");
        offCtx.drawImage(img, 0, 0, targetWidth, targetHeight);
        const imageData = offCtx.getImageData(0, 0, targetWidth, targetHeight);
        // Compute offsets to center the barrier image in the simulation grid.
        const offsetX = Math.floor((gridWidth - targetWidth) / 2);
        const offsetY = Math.floor((gridHeight - targetHeight) / 2);
        const threshold = parseFloat(ui.thresholdSlider.value);
        // Update barrierArray: set to 1 for pixels with brightness above threshold.
        for (let j = 0; j < targetHeight; j++) {
          for (let i = 0; i < targetWidth; i++) {
            const idx = ((targetHeight - j) * targetWidth + i) * 4;
            // Compute normalized brightness (average of R, G, B).
            const b = (imageData.data[idx] + imageData.data[idx + 1] + imageData.data[idx + 2]) / (3 * 255);
            const brightness = ui.barrierInvert.checked ? 1 - b : b;
            if (brightness > threshold) {
              const simX = offsetX + i;
              const simY = offsetY + j;
              if (simX >= 0 && simX < gridWidth && simY >= 0 && simY < gridHeight) {
                barrierArray[simY * gridWidth + simX] = 1;
              }
            }
          }
        }
        device.queue.writeBuffer(barrierBuffer, 0, barrierArray.buffer);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });

  ui.barrierClear.addEventListener("click", () => {
    clearBarriers();
  });
  function clearBarriers() {
    barrierArray.fill(0);
    device.queue.writeBuffer(barrierBuffer, 0, barrierArray.buffer);
  }

  // ----- Simulation Loop -----
  let useBuffer0 = true;
  function frame() {
    const commandEncoder = device.createCommandEncoder();
    for (let i = 0; i < speed; i++) {
      {
        const collisionPass = commandEncoder.beginComputePass();
        collisionPass.setPipeline(collisionPipeline);
        collisionPass.setBindGroup(0, collisionBindGroup(useBuffer0 ? stateBuffer0 : stateBuffer1));
        collisionPass.dispatchWorkgroups(Math.ceil(gridWidth / 16), Math.ceil(gridHeight / 16));
        collisionPass.end();
      }

      {
        const streamingPass = commandEncoder.beginComputePass();
        streamingPass.setPipeline(streamingPipeline);
        streamingPass.setBindGroup(0, streamingBindGroup(useBuffer0 ? stateBuffer1 : stateBuffer0));
        streamingPass.dispatchWorkgroups(Math.ceil(gridWidth / 16), Math.ceil(gridHeight / 16));
        streamingPass.end();
      }
      useBuffer0 = !useBuffer0;
    }

    const textureView = context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup(useBuffer0 ? stateBuffer1 : stateBuffer0));
    renderPass.draw(3, 1, 0, 0);
    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- Other event listeners ----
  ui.collapse.onclick = () => {
    ui.collapse.innerText = ui.collapse.innerText === ">" ? "<" : ">";
    if (ui.panel.classList.contains("hidden")) {
      ui.panel.classList.remove("hidden");
    } else {
      ui.panel.classList.add("hidden");
    }
  };
  window.onresize = () => {
    if (window.innerWidth > canvas.width) location.reload();
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    refreshGrid();
  }
})();