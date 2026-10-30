<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* ============================================================
 * GPGPU 粒子流场（WebGL2）
 *  - 状态存在浮点纹理里：位置 (xyz + 寿命) / 速度 (xyz + 速度模长)
 *  - 一次 draw 带两个颜色附件（MRT），同时更新位置与速度，乒乓切换
 *  - 渲染阶段 gl_VertexID → texelFetch 取状态，加法混合出光带
 *  - CPU 每帧只更新几个 uniform，粒子全部在 GPU 上迭代
 * ============================================================ */

const container = ref<HTMLDivElement>()
const glRef = ref<WebGL2RenderingContext | null>(null)
const unsupported = ref('')

const RES = ref(320) // 320² = 102400 个粒子
const force = ref(1)
const autoSpin = ref(true)
const particleSize = ref(2.4)
const fps = ref(0)
const count = ref(RES.value * RES.value)

let raf = 0
let gl: WebGL2RenderingContext | null = null
let canvas: HTMLCanvasElement | null = null
let simProg: WebGLProgram | null = null
let drawProg: WebGLProgram | null = null
let emptyVao: WebGLVertexArrayObject | null = null

interface Fbo {
  fbo: WebGLFramebuffer
  pos: WebGLTexture
  vel: WebGLTexture
}
let stateA: Fbo | null = null
let stateB: Fbo | null = null
let readIsA = true

/* ---------------- 矩阵 ---------------- */
function perspective(fovy: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) * nf
  m[11] = -1
  m[14] = 2 * far * near * nf
  return m
}

function lookAt(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number],
) {
  const out = new Float32Array(16)
  const z0 = eye[0] - center[0]
  const z1 = eye[1] - center[1]
  const z2 = eye[2] - center[2]
  const zl = Math.hypot(z0, z1, z2) || 1
  const z = [z0 / zl, z1 / zl, z2 / zl]

  const x0 = up[1] * z[2] - up[2] * z[1]
  const x1 = up[2] * z[0] - up[0] * z[2]
  const x2 = up[0] * z[1] - up[1] * z[0]
  const xl = Math.hypot(x0, x1, x2) || 1
  const x = [x0 / xl, x1 / xl, x2 / xl]

  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]

  out[0] = x[0]
  out[1] = y[0]
  out[2] = z[0]
  out[3] = 0
  out[4] = x[1]
  out[5] = y[1]
  out[6] = z[1]
  out[7] = 0
  out[8] = x[2]
  out[9] = y[2]
  out[10] = z[2]
  out[11] = 0
  out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2])
  out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2])
  out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2])
  out[15] = 1
  return out
}

function mul(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]
      o[i * 4 + j] = s
    }
  }
  return o
}

/* ---------------- 着色器 ---------------- */
const SIM_VS = `#version 300 es
void main() {
  // 无 VBO：用 gl_VertexID 造一个覆盖全屏的三角形
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uTime;
uniform float uDt;
uniform float uForce;

layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** 三个正弦交叉的旋涡场：无源、平滑、无奇点，适合做流场 */
vec3 field(vec3 p, float t) {
  return vec3(
    sin(p.y * 1.7 + t * 0.55) + cos(p.z * 2.3 - t * 0.41),
    sin(p.z * 1.9 - t * 0.47) + cos(p.x * 1.5 + t * 0.62),
    sin(p.x * 2.1 + t * 0.39) + cos(p.y * 1.3 - t * 0.53)
  );
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, c, 0);
  vec4 V = texelFetch(uVel, c, 0);

  vec3 p = P.xyz;
  vec3 v = V.xyz;
  float life = P.w;

  float r = length(p);
  // 旋涡场 + 弹性回中：回中用弹簧而不是向心归一化，粒子才会填满体积而不是聚成一层壳
  // 每颗粒子一个不同的弹簧系数（存在速度纹理的 w 通道里）：
  // 系数一致时所有粒子会收敛到同一个平衡半径，聚成一层壳；系数离散后才会填满体积
  float stiff = 0.85 + V.w * 2.1;
  vec3 acc = field(p, uTime) * uForce * 0.62 - p * stiff;

  v = (v + acc * uDt) * 0.977;
  p += v * uDt;
  life -= uDt;

  // 出界或寿命结束 → 在内核里重新播种，CPU 完全不介入
  if (life <= 0.0 || r > 1.0) {
    vec3 seed = vec3(
      hash12(vec2(c) + fract(uTime) * 91.7),
      hash12(vec2(c.yx) * 1.37 + uTime * 0.7),
      hash12(vec2(c) * 2.11 - uTime * 1.1)
    ) - 0.5;
    vec3 dir = normalize(seed + vec3(0.001, 0.0017, 0.0023));
    // 立方根分布 → 球内均匀，不会聚到球壳上
    p = dir * (0.1 + 0.58 * pow(hash12(vec2(c) * 5.7 + uTime * 2.3), 0.3333));
    v = vec3(0.0);
    life = 2.4 + 3.4 * hash12(vec2(c) * 3.7 + uTime * 1.3);
  }

  outPos = vec4(p, life);
  outVel = vec4(v, V.w);
}`

const DRAW_VS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform mat4 uVP;
uniform float uSize;
uniform int uRes;

out vec3 vColor;
out float vAlpha;

void main() {
  ivec2 c = ivec2(gl_VertexID % uRes, gl_VertexID / uRes);
  vec4 P = texelFetch(uPos, c, 0);
  vec4 V = texelFetch(uVel, c, 0);

  vec3 p = P.xyz;
  vec4 clip = uVP * vec4(p, 1.0);
  gl_Position = clip;

  float sp = length(V.xyz);
  gl_PointSize = uSize * (0.55 + sp * 0.5) * (2.6 / max(0.25, clip.w));

  // 慢的偏蓝、快的偏金，再亮一点高光
  vec3 col = mix(vec3(0.13, 0.42, 1.0), vec3(0.35, 0.86, 1.0), clamp(sp * 0.9, 0.0, 1.0));
  col = mix(col, vec3(1.0, 0.82, 0.42), clamp(sp * 0.75 - 0.55, 0.0, 1.0));
  vColor = col;
  // 出生/消亡时淡入淡出，避免粒子凭空出现
  vAlpha = smoothstep(0.0, 0.6, P.w) * smoothstep(4.8, 3.2, P.w) * 0.55;
}`

const DRAW_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 1.8) * vAlpha;
  outColor = vec4(vColor * a, a);
}`

/* ---------------- 工具 ---------------- */
function compile(type: number, src: string) {
  if (!gl) return null
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('shader:', gl.getShaderInfoLog(sh))
    return null
  }
  return sh
}

function program(vs: string, fs: string) {
  if (!gl) return null
  const v = compile(gl.VERTEX_SHADER, vs)
  const f = compile(gl.FRAGMENT_SHADER, fs)
  if (!v || !f) return null
  const p = gl.createProgram()!
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('link:', gl.getProgramInfoLog(p))
    return null
  }
  return p
}

function createFbo(res: number, seed: boolean): Fbo {
  const g = gl!
  const make = (init: Float32Array | null) => {
    const t = g.createTexture()!
    g.bindTexture(g.TEXTURE_2D, t)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, res, res, 0, g.RGBA, g.FLOAT, init)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    return t
  }

  let posData: Float32Array | null = null
  let velData: Float32Array | null = null
  if (seed) {
    posData = new Float32Array(res * res * 4)
    velData = new Float32Array(res * res * 4)
    for (let i = 0; i < res * res; i++) {
      const a = Math.random() * Math.PI * 2
      const b = Math.acos(1 - 2 * Math.random())
      const rr = 0.1 + Math.random() * 0.6
      posData[i * 4] = Math.sin(b) * Math.cos(a) * rr
      posData[i * 4 + 1] = Math.cos(b) * 0.75 * rr
      posData[i * 4 + 2] = Math.sin(b) * Math.sin(a) * rr
      posData[i * 4 + 3] = 1 + Math.random() * 4
      velData[i * 4] = 0
      velData[i * 4 + 1] = 0
      velData[i * 4 + 2] = 0
      velData[i * 4 + 3] = Math.random()
    }
  }

  const pos = make(posData)
  const vel = make(velData)
  const fbo = g.createFramebuffer()!
  g.bindFramebuffer(g.FRAMEBUFFER, fbo)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, pos, 0)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT1, g.TEXTURE_2D, vel, 0)
  g.drawBuffers([g.COLOR_ATTACHMENT0, g.COLOR_ATTACHMENT1])
  g.bindFramebuffer(g.FRAMEBUFFER, null)
  return { fbo, pos, vel }
}

function disposeFbo(f: Fbo | null) {
  if (!f || !gl) return
  gl.deleteFramebuffer(f.fbo)
  gl.deleteTexture(f.pos)
  gl.deleteTexture(f.vel)
}

/* ---------------- 相机 ---------------- */
let yaw = 0.6
let pitch = 0.32
let dist = 2.35
let dragging = false
let lastX = 0
let lastY = 0

const cleanups: Array<() => void> = []

onMounted(() => {
  const el = container.value
  if (!el) return

  canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const ctx = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: false })
  if (!ctx) {
    unsupported.value = '当前环境不支持 WebGL2'
    return
  }
  gl = ctx
  glRef.value = ctx

  if (!gl.getExtension('EXT_color_buffer_float')) {
    unsupported.value = '缺少 EXT_color_buffer_float，无法渲染到浮点纹理'
    return
  }
  gl.getExtension('OES_texture_float_linear')

  simProg = program(SIM_VS, SIM_FS)
  drawProg = program(DRAW_VS, DRAW_FS)
  emptyVao = gl.createVertexArray()

  function rebuildState() {
    disposeFbo(stateA)
    disposeFbo(stateB)
    stateA = createFbo(RES.value, true)
    stateB = createFbo(RES.value, false)
    readIsA = true
    count.value = RES.value * RES.value
  }
  rebuildState()

  function resize() {
    if (!gl || !canvas || !el) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(el.clientWidth * dpr))
    canvas.height = Math.max(1, Math.floor(el.clientHeight * dpr))
  }
  resize()
  window.addEventListener('resize', resize)
  cleanups.push(() => window.removeEventListener('resize', resize))

  /* --- 交互 --- */
  const onDown = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas!.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    yaw -= (e.clientX - lastX) * 0.007
    pitch = Math.max(-1.35, Math.min(1.35, pitch + (e.clientY - lastY) * 0.006))
    lastX = e.clientX
    lastY = e.clientY
  }
  const onUp = () => {
    dragging = false
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    dist = Math.max(1.5, Math.min(6.5, dist * (1 + e.deltaY * 0.0011)))
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  cleanups.push(() => {
    canvas?.removeEventListener('pointerdown', onDown)
    canvas?.removeEventListener('pointermove', onMove)
    canvas?.removeEventListener('pointerup', onUp)
    canvas?.removeEventListener('wheel', onWheel)
  })

  // 粒子数档位切换时重建状态纹理
  let lastRes = RES.value
  const resWatch = window.setInterval(() => {
    if (RES.value !== lastRes) {
      lastRes = RES.value
      rebuildState()
    }
  }, 300)
  cleanups.push(() => window.clearInterval(resWatch))

  /* --- 主循环 --- */
  let t0 = performance.now()
  let simTime = 0
  let frames = 0
  let fpsClock = performance.now()

  const uSim = {
    pos: gl.getUniformLocation(simProg!, 'uPos'),
    vel: gl.getUniformLocation(simProg!, 'uVel'),
    time: gl.getUniformLocation(simProg!, 'uTime'),
    dt: gl.getUniformLocation(simProg!, 'uDt'),
    force: gl.getUniformLocation(simProg!, 'uForce'),
  }
  const uDraw = {
    pos: gl.getUniformLocation(drawProg!, 'uPos'),
    vel: gl.getUniformLocation(drawProg!, 'uVel'),
    vp: gl.getUniformLocation(drawProg!, 'uVP'),
    size: gl.getUniformLocation(drawProg!, 'uSize'),
    res: gl.getUniformLocation(drawProg!, 'uRes'),
  }

  const loop = () => {
    raf = requestAnimationFrame(loop)
    if (!gl || !canvas) return
    const now = performance.now()
    const dt = Math.min(0.033, (now - t0) / 1000)
    t0 = now
    simTime += dt

    if (autoSpin.value && !dragging) yaw += dt * 0.16

    // ---- 模拟：写另一组纹理 ----
    const src = readIsA ? stateA! : stateB!
    const dst = readIsA ? stateB! : stateA!
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
    gl.viewport(0, 0, RES.value, RES.value)
    gl.useProgram(simProg)
    gl.bindVertexArray(emptyVao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.pos)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, src.vel)
    gl.uniform1i(uSim.pos, 0)
    gl.uniform1i(uSim.vel, 1)
    gl.uniform1f(uSim.time, simTime)
    gl.uniform1f(uSim.dt, dt)
    gl.uniform1f(uSim.force, force.value)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    readIsA = !readIsA

    // ---- 渲染 ----
    const w = canvas.width
    const h = canvas.height
    gl.viewport(0, 0, w, h)
    gl.clearColor(0.016, 0.024, 0.043, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)

    const cp = Math.cos(pitch)
    const eye: [number, number, number] = [
      Math.sin(yaw) * cp * dist,
      Math.sin(pitch) * dist,
      Math.cos(yaw) * cp * dist,
    ]
    const vp = mul(
      perspective((52 * Math.PI) / 180, w / h, 0.05, 40),
      lookAt(eye, [0, 0, 0], [0, 1, 0]),
    )

    gl.useProgram(drawProg)
    gl.bindVertexArray(emptyVao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, dst.pos)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, dst.vel)
    gl.uniform1i(uDraw.pos, 0)
    gl.uniform1i(uDraw.vel, 1)
    gl.uniformMatrix4fv(uDraw.vp, false, vp)
    gl.uniform1f(uDraw.size, particleSize.value * Math.min(window.devicePixelRatio || 1, 2))
    gl.uniform1i(uDraw.res, RES.value)
    gl.drawArrays(gl.POINTS, 0, RES.value * RES.value)

    gl.disable(gl.BLEND)

    frames++
    if (now - fpsClock > 500) {
      fps.value = Math.round((frames * 1000) / (now - fpsClock))
      frames = 0
      fpsClock = now
    }
  }
  loop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  cleanups.forEach((fn) => fn())
  cleanups.length = 0
  disposeFbo(stateA)
  disposeFbo(stateB)
  if (gl) {
    if (simProg) gl.deleteProgram(simProg)
    if (drawProg) gl.deleteProgram(drawProg)
    if (emptyVao) gl.deleteVertexArray(emptyVao)
  }
  canvas?.remove()
  canvas = null
  gl = null
  glRef.value = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>

    <div v-if="unsupported" class="unsupported">{{ unsupported }}</div>

    <div class="panel">
      <div class="title">
        <span class="dot"></span>
        GPGPU 粒子流场
      </div>
      <div class="sub">
        {{ (count / 1000).toFixed(0) }}k 粒子 · {{ RES }}×{{ RES }} 浮点纹理乒乓 · {{ fps }} FPS
      </div>

      <div class="ctrl">
        <span class="lab">粒子</span>
        <input v-model.number="RES" type="range" min="128" max="512" step="64" />
        <b>{{ RES }}²</b>
      </div>
      <div class="ctrl">
        <span class="lab">力场</span>
        <input v-model.number="force" type="range" min="0" max="3" step="0.05" />
        <b>{{ force.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">粒径</span>
        <input v-model.number="particleSize" type="range" min="1" max="5" step="0.1" />
        <b>{{ particleSize.toFixed(1) }}</b>
      </div>

      <label class="check">
        <input v-model="autoSpin" type="checkbox" />
        <span>自动旋转（也可拖拽 / 滚轮）</span>
      </label>

      <div class="tip">
        位置与速度各存一张 RGBA32F 纹理，一次 draw 通过两个颜色附件同时写回，
        两组 FBO 乒乓切换；顶点着色器用 gl_VertexID 反查纹素，CPU 不参与任何粒子计算。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #04070c;
}
.gl-container {
  width: 100%;
  height: 100%;
}
.unsupported {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #f2a33c;
  font-size: 13px;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 288px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.86);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4aa3ff;
  box-shadow: 0 0 9px #4aa3ff;
}
.sub {
  margin-top: 3px;
  font-size: 11px;
  color: #7d8fa2;
  font-family: ui-monospace, monospace;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
}
.ctrl .lab {
  flex: 0 0 26px;
  color: #8fa0b3;
}
.ctrl input[type='range'] {
  flex: 1;
  height: 3px;
  appearance: none;
  background: rgba(96, 116, 140, 0.5);
  border-radius: 2px;
  outline: none;
}
.ctrl input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #6fb3f2;
  border: 2px solid #0a1118;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 38px;
  text-align: right;
  font-family: ui-monospace, monospace;
  color: #ffd479;
  font-size: 11.5px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
  font-size: 11.5px;
  color: #a9b8c8;
  cursor: pointer;
}
.tip {
  margin-top: 9px;
  font-size: 11px;
  line-height: 1.6;
  color: #7d8fa2;
}
</style>
