<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  createCube,
  createProgram,
  createSphere,
  lookAt,
  multiply,
  perspective,
  rotationY,
  scaling,
  setupGL,
  translation,
  type GLContext,
} from './gl'

/**
 * HDR 色调映射
 *
 * 线性空间里颜色是可以大于 1 的（阳光、灯、高光）。直接写进 8 位帧缓冲会被截断成
 * 一片死白 —— 色调映射就是把「0~∞ 的亮度」压回「0~1 的显示范围」，同时尽量保住高光层次。
 *
 * 这里为了把曲线本身看清楚，不做离屏浮点缓冲：场景算完直接映射后输出（数学上等价）。
 * 真实管线中间是 float 纹理，后面还会接 Bloom / 调色。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

type Curve = 'none' | 'linear' | 'reinhard' | 'aces' | 'filmic'
const curve = ref<Curve>('aces')
const exposure = ref(1.4)
const gamma = ref(true)
const stats = ref({ fps: 0 })

let prog: WebGLProgram | null = null
let cube = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let sphere = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let u: Record<string, WebGLUniformLocation | null> = {}
let frames = 0
let lastFps = performance.now()

const CURVES: Array<{ id: Curve; label: string }> = [
  { id: 'none', label: '直接截断' },
  { id: 'linear', label: '线性' },
  { id: 'reinhard', label: 'Reinhard' },
  { id: 'aces', label: 'ACES' },
  { id: 'filmic', label: 'Filmic' },
]

const VS = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vNormal = normalize(uNormalMat * aNormal);
  vWorld = (uModel * vec4(aPos, 1.0)).xyz;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vWorld;
uniform vec3 uBase;
uniform float uEmit;        // 自发光强度，允许 > 1
uniform float uExposure;
uniform int uCurve;
uniform float uGamma;

vec3 aces(vec3 x) {
  // Narkowicz 2015 的 ACES 拟合，够用且便宜
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 filmic(vec3 x) {
  // Uncharted2 的简化版：肩部更软，暗部压得更狠
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  vec3 c = ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 L = normalize(vec3(0.35, 0.75, 0.55));
  float diff = max(dot(n, L), 0.0);
  vec3 V = normalize(vec3(0.0, 0.0, 1.0));
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.0), 48.0);

  // 线性 HDR：漫反射 + 强高光 + 自发光，轻松超过 1
  vec3 hdr = uBase * (0.04 + 0.22 * diff) + vec3(spec * 1.4) + uBase * uEmit;
  hdr *= uExposure;

  vec3 c;
  if (uCurve == 0) {
    c = clamp(hdr, 0.0, 1.0);            // 不做映射：高光全糊成白色
  } else if (uCurve == 1) {
    c = clamp(hdr, 0.0, 1.0);            // 线性：只压曝光
  } else if (uCurve == 2) {
    c = hdr / (1.0 + hdr);               // Reinhard：便宜，但整体发灰
  } else if (uCurve == 3) {
    c = aces(hdr);                       // ACES：高光滚降自然，目前业界默认
  } else {
    c = filmic(hdr);
  }

  if (uGamma > 0.5) c = pow(c, vec3(1.0 / 2.2));  // 线性 → sRGB
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`

function compile() {
  const gl = ctx!.gl
  prog = createProgram(gl, VS, FS)
  if (!prog) return false
  u = {
    uProj: gl.getUniformLocation(prog, 'uProj'),
    uView: gl.getUniformLocation(prog, 'uView'),
    uModel: gl.getUniformLocation(prog, 'uModel'),
    uNormalMat: gl.getUniformLocation(prog, 'uNormalMat'),
    uBase: gl.getUniformLocation(prog, 'uBase'),
    uEmit: gl.getUniformLocation(prog, 'uEmit'),
    uExposure: gl.getUniformLocation(prog, 'uExposure'),
    uCurve: gl.getUniformLocation(prog, 'uCurve'),
    uGamma: gl.getUniformLocation(prog, 'uGamma'),
  }
  return true
}

function buffer(data: Float32Array | Uint16Array, target: number) {
  const gl = ctx!.gl
  const b = gl.createBuffer()!
  gl.bindBuffer(target, b)
  gl.bufferData(target, data, gl.STATIC_DRAW)
  return b
}

function buildGeometry() {
  const gl = ctx!.gl
  const c = createCube()
  cube.count = c.indices.length
  cube.pos = buffer(c.positions, gl.ARRAY_BUFFER)
  cube.nrm = buffer(c.normals, gl.ARRAY_BUFFER)
  cube.idx = buffer(c.indices, gl.ELEMENT_ARRAY_BUFFER)
  const s = createSphere(36, 24)
  sphere.count = s.indices.length
  sphere.pos = buffer(s.positions, gl.ARRAY_BUFFER)
  sphere.nrm = buffer(s.normals, gl.ARRAY_BUFFER)
  sphere.idx = buffer(s.indices, gl.ELEMENT_ARRAY_BUFFER)
}

function bindMesh(m: typeof cube) {
  const gl = ctx!.gl
  gl.bindBuffer(gl.ARRAY_BUFFER, m.pos)
  const aPos = gl.getAttribLocation(prog!, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, m.nrm)
  const aNrm = gl.getAttribLocation(prog!, 'aNormal')
  gl.enableVertexAttribArray(aNrm)
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx)
}

const curveIndex: Record<Curve, number> = { none: 0, linear: 1, reinhard: 2, aces: 3, filmic: 4 }

function render(now: number) {
  if (!ctx || !prog) return
  const gl = ctx!.gl
  const t = now * 0.001
  gl.viewport(0, 0, ctx!.canvas.width, ctx!.canvas.height)
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.008, 0.01, 0.016, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((46 * Math.PI) / 180, aspect, 0.1, 100)
  const view = lookAt([0, 2.1, 9.4], [0, 0.55, 0], [0, 1, 0])
  gl.useProgram(prog)
  gl.uniformMatrix4fv(u.uProj, false, proj)
  gl.uniformMatrix4fv(u.uView, false, view)
  gl.uniform1f(u.uExposure, exposure.value)
  gl.uniform1i(u.uCurve, curveIndex[curve.value])
  gl.uniform1f(u.uGamma, gamma.value ? 1 : 0)

  // 一排「灯箱」：自发光 0.5 / 1 / 2 / 4 / 8，看哪条曲线还能分出层次
  const emits = [0.3, 1, 2.5, 6, 14]
  bindMesh(cube)
  for (let i = 0; i < emits.length; i++) {
    const x = (i - 2) * 1.5
    const m = multiply(
      multiply(translation(x, 0.55, 0), rotationY(-0.22 + i * 0.11)),
      scaling(0.45),
    )
    const nm = new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
    gl.uniformMatrix4fv(u.uModel, false, m)
    gl.uniformMatrix3fv(u.uNormalMat, false, nm)
    gl.uniform3f(u.uBase, 1.0, 0.72, 0.42)
    gl.uniform1f(u.uEmit, emits[i])
    gl.drawElements(gl.TRIANGLES, cube.count, gl.UNSIGNED_SHORT, 0)
  }

  // 金属球：高光更亮，专门用来看肩部滚降
  bindMesh(sphere)
  const sm = multiply(multiply(translation(0, 1.85, 1.4), rotationY(t * 0.3)), scaling(0.75))
  const snm = new Float32Array([sm[0], sm[1], sm[2], sm[4], sm[5], sm[6], sm[8], sm[9], sm[10]])
  gl.uniformMatrix4fv(u.uModel, false, sm)
  gl.uniformMatrix3fv(u.uNormalMat, false, snm)
  gl.uniform3f(u.uBase, 0.55, 0.72, 1.0)
  gl.uniform1f(u.uEmit, 0.35)
  gl.drawElements(gl.TRIANGLES, sphere.count, gl.UNSIGNED_SHORT, 0)

  frames++
  if (now - lastFps > 500) {
    stats.value.fps = Math.round((frames * 1000) / (now - lastFps))
    frames = 0
    lastFps = now
  }
  raf = requestAnimationFrame(render)
}

onMounted(() => {
  if (!container.value) return
  ctx = setupGL(container.value)
  if (!ctx) return
  if (!compile()) return
  buildGeometry()
  raf = requestAnimationFrame(render)
  const onResize = () => ctx!.resize()
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    if (prog) gl.deleteProgram(prog)
    for (const m of [cube, sphere]) for (const b of [m.pos, m.nrm, m.idx]) if (b) gl.deleteBuffer(b)
  }
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">HDR 色调映射 · 5 种曲线</div>
      <div class="sub">自发光 0.3 / 1 / 2.5 / 6 / 14 · {{ stats.fps }} fps</div>

      <div class="chips">
        <button
          v-for="c in CURVES"
          :key="c.id"
          class="chip"
          :class="{ on: curve === c.id }"
          @click="curve = c.id"
        >
          {{ c.label }}
        </button>
      </div>

      <div class="ctrl">
        <span class="lab">曝光</span>
        <input v-model.number="exposure" type="range" min="0.2" max="6" step="0.05" />
        <b>{{ exposure.toFixed(2) }}<i>EV</i></b>
      </div>
      <button class="chip wide" :class="{ on: gamma }" @click="gamma = !gamma">
        Gamma 校正 {{ gamma ? '开' : '关' }}
      </button>

      <div class="tip">
        五个灯箱的自发光从 0.3 到 14——「直接截断」和「线性」会把 1 以上全压成死白，
        只能看出两个台阶；Reinhard 便宜但发灰；<b>ACES</b> 高光滚降最自然，是现在的默认选择。
        线性值写进 8 位帧缓冲前必须做 gamma（1/2.2），否则整体偏暗、灰阶不对。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.gl-container {
  width: 100%;
  height: 100%;
  background: #04060a;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 320px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #7d8fa2;
  font-family: ui-monospace, monospace;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;
}
.chip {
  padding: 3px 8px;
  font-size: 11px;
  color: #b7c6d6;
  background: rgba(38, 50, 64, 0.9);
  border: 1px solid rgba(96, 116, 140, 0.4);
  border-radius: 6px;
  cursor: pointer;
}
.chip.on {
  color: #06121a;
  background: #6fb3f2;
  border-color: #6fb3f2;
  font-weight: 600;
}
.chip.wide {
  width: 100%;
  margin-top: 10px;
  padding: 5px 0;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}
.lab {
  flex: 0 0 46px;
  font-size: 11px;
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
  border: 2px solid #0e141c;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 52px;
  text-align: right;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #cfe4f5;
  font-weight: 500;
}
.ctrl b i {
  font-style: normal;
  font-size: 9.5px;
  color: #6f8296;
  margin-left: 1px;
}
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.24);
  font-size: 10.5px;
  line-height: 1.6;
  color: #7b8b9d;
}
.tip b {
  color: #cfe4f5;
}
</style>
