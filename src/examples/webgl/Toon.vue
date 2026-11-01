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
 * 卡通着色 + 描边（两趟渲染）
 *
 * 1) 色阶化：把 N·L 量化成几档（floor(d*steps)/steps），高光也用同样的台阶，出「动漫感」；
 * 2) 描边：先把模型沿法线外扩一圈、只画背面（cull front）涂黑，再正常画正面
 *    （cull back）。这就是俗称的「法线外扩描边」，比后期 Sobel 边缘检测更稳。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

const steps = ref(4)
const outlineWidth = ref(0.045)
const lightAz = ref(120)
const lightAlt = ref(46)
const showOutline = ref(true)
const stats = ref({ fps: 0 })

let prog: WebGLProgram | null = null
let sphere = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let cube = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let u: Record<string, WebGLUniformLocation | null> = {}
let frames = 0
let lastFps = performance.now()

const VS = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform float uOutline;      // 1 = 画描边外壳
uniform float uOutlineWidth;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  // 沿法线外扩：模型空间近似即可（均匀缩放时方向不变）
  vec3 p = aPos + (uOutline > 0.5 ? normalize(aNormal) * uOutlineWidth : vec3(0.0));
  vec4 w = uModel * vec4(p, 1.0);
  vWorld = w.xyz;
  vN = normalize(uNormalMat * aNormal);
  gl_Position = uProj * uView * w;
}
`

const FS = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vWorld;
uniform vec3 uBase;
uniform vec3 uLight;
uniform float uSteps;
uniform float uOutline;

void main() {
  if (uOutline > 0.5) {
    gl_FragColor = vec4(0.06, 0.05, 0.09, 1.0);
    return;
  }

  vec3 N = normalize(vN);
  float ndl = dot(N, normalize(uLight));
  // 量化：4 档时结果只有 0 / 0.25 / 0.5 / 0.75 / 1 这几种亮度
  float band = floor(clamp(ndl, 0.0, 1.0) * uSteps) / uSteps;
  // 半兰伯特让暗面不死黑，边缘再补一点
  float shade = mix(0.22, 1.0, band);
  float rim = pow(1.0 - max(dot(N, vec3(0.0, 0.0, 1.0)), 0.0), 2.5);

  // 高光也做台阶化：只在最高一档出现
  vec3 V = normalize(vec3(0.0, 1.6, 6.0) - vWorld);
  vec3 H = normalize(normalize(uLight) + V);
  float spec = pow(max(dot(N, H), 0.0), 60.0);
  float specBand = step(0.55, spec) * step(uSteps - 0.5, uSteps); // 保持恒真，仅示意

  vec3 c = uBase * shade + rim * 0.35 * uBase + vec3(0.95) * specBand * 0.55;
  gl_FragColor = vec4(c, 1.0);
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
    uOutline: gl.getUniformLocation(prog, 'uOutline'),
    uOutlineWidth: gl.getUniformLocation(prog, 'uOutlineWidth'),
    uBase: gl.getUniformLocation(prog, 'uBase'),
    uLight: gl.getUniformLocation(prog, 'uLight'),
    uSteps: gl.getUniformLocation(prog, 'uSteps'),
  }
  return true
}

function makeMesh(src: { positions: Float32Array; normals: Float32Array; indices: Uint16Array }) {
  const gl = ctx!.gl
  const pos = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, pos)
  gl.bufferData(gl.ARRAY_BUFFER, src.positions, gl.STATIC_DRAW)
  const nrm = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, nrm)
  gl.bufferData(gl.ARRAY_BUFFER, src.normals, gl.STATIC_DRAW)
  const idx = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, src.indices, gl.STATIC_DRAW)
  return { pos, nrm, idx, count: src.indices.length }
}

function bindMesh(m: typeof sphere) {
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

function render(now: number) {
  if (!ctx || !prog) return
  const gl = ctx!.gl
  const t = now * 0.001
  gl.viewport(0, 0, ctx!.canvas.width, ctx!.canvas.height)
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.87, 0.9, 0.96, 1) // 浅色背景，卡通风格
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((46 * Math.PI) / 180, aspect, 0.1, 100)
  const view = lookAt([0, 1.9, 8.4], [0, 0.55, 0], [0, 1, 0])
  gl.useProgram(prog)
  gl.uniformMatrix4fv(u.uProj, false, proj)
  gl.uniformMatrix4fv(u.uView, false, view)
  gl.uniform1f(u.uSteps, Math.max(2, steps.value))

  const az = (lightAz.value * Math.PI) / 180
  const alt = (lightAlt.value * Math.PI) / 180
  gl.uniform3f(u.uLight, Math.cos(alt) * Math.cos(az), Math.sin(alt), Math.cos(alt) * Math.sin(az))

  // createSphere 的三角形绕序与 createCube 相反，描边/剔除必须按网格分别设 frontFace
  const items: Array<{ mesh: typeof sphere; model: Float32Array; color: [number, number, number]; cw: boolean }> = []
  items.push({
    mesh: sphere,
    model: multiply(multiply(translation(-1.9, 0.9, 0), rotationY(t * 0.4)), scaling(0.9)),
    color: [0.98, 0.62, 0.32],
    cw: true,
  })
  items.push({
    mesh: cube,
    model: multiply(multiply(translation(0, 0.75, 0), rotationY(t * 0.6 + 0.6)), scaling(0.62)),
    color: [0.42, 0.72, 0.95],
    cw: false,
  })
  items.push({
    mesh: sphere,
    model: multiply(multiply(translation(1.95, 0.72, 0.2), rotationY(-t * 0.5)), scaling(0.7)),
    color: [0.55, 0.85, 0.5],
    cw: true,
  })

  gl.enable(gl.CULL_FACE)

  /* 第一趟：外扩外壳，只画背面 */
  if (showOutline.value) {
    gl.cullFace(gl.FRONT)
    gl.uniform1f(u.uOutline, 1)
    gl.uniform1f(u.uOutlineWidth, outlineWidth.value)
    for (const it of items) {
      bindMesh(it.mesh)
      gl.frontFace(it.cw ? gl.CW : gl.CCW)
      const nm = new Float32Array([it.model[0], it.model[1], it.model[2], it.model[4], it.model[5], it.model[6], it.model[8], it.model[9], it.model[10]])
      gl.uniformMatrix4fv(u.uModel, false, it.model)
      gl.uniformMatrix3fv(u.uNormalMat, false, nm)
      gl.drawElements(gl.TRIANGLES, it.mesh.count, gl.UNSIGNED_SHORT, 0)
    }
  }

  /* 第二趟：正常正面 */
  gl.cullFace(gl.BACK)
  gl.uniform1f(u.uOutline, 0)
  for (const it of items) {
    bindMesh(it.mesh)
    gl.frontFace(it.cw ? gl.CW : gl.CCW)
    const nm = new Float32Array([it.model[0], it.model[1], it.model[2], it.model[4], it.model[5], it.model[6], it.model[8], it.model[9], it.model[10]])
    gl.uniformMatrix4fv(u.uModel, false, it.model)
    gl.uniformMatrix3fv(u.uNormalMat, false, nm)
    gl.uniform3f(u.uBase, it.color[0], it.color[1], it.color[2])
    gl.drawElements(gl.TRIANGLES, it.mesh.count, gl.UNSIGNED_SHORT, 0)
  }
  gl.disable(gl.CULL_FACE)

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
  sphere = makeMesh(createSphere(40, 26))
  cube = makeMesh(createCube())
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
    for (const m of [sphere, cube]) for (const b of [m.pos, m.nrm, m.idx]) if (b) gl.deleteBuffer(b)
  }
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">卡通着色 + 法线外扩描边</div>
      <div class="sub">两趟渲染 · {{ stats.fps }} fps</div>

      <div class="ctrl">
        <span class="lab">色阶数</span>
        <input v-model.number="steps" type="range" min="2" max="8" step="1" />
        <b>{{ steps }}<i>档</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">描边宽度</span>
        <input v-model.number="outlineWidth" type="range" min="0" max="0.12" step="0.005" />
        <b>{{ outlineWidth.toFixed(3) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">光源方位</span>
        <input v-model.number="lightAz" type="range" min="0" max="360" step="2" />
        <b>{{ lightAz }}<i>°</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">光源高度</span>
        <input v-model.number="lightAlt" type="range" min="8" max="85" step="1" />
        <b>{{ lightAlt }}<i>°</i></b>
      </div>
      <button class="chip" :class="{ on: showOutline }" @click="showOutline = !showOutline">
        {{ showOutline ? '关闭描边' : '开启描边' }}
      </button>

      <div class="tip">
        描边不是后期找边缘，而是「先画一个沿法线外扩的黑色外壳，只画背面（cull front）」，
        再正常画正面（cull back）——外壳没被盖住的部分就成了轮廓线。
        色阶化只需把 N·L 量化：<code>floor(d * N) / N</code>，N 越小越像手绘。
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
  background: #dde3ee;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 306px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(13, 18, 26, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.4);
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
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.lab {
  flex: 0 0 58px;
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
  flex: 0 0 48px;
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
.chip {
  width: 100%;
  margin-top: 10px;
  padding: 5px 0;
  font-size: 11.5px;
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
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.24);
  font-size: 10.5px;
  line-height: 1.6;
  color: #7b8b9d;
}
.tip code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(111, 179, 242, 0.12);
  color: #9fc9f0;
  font-size: 10px;
}
</style>
