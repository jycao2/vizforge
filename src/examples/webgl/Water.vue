<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  bindFramebuffer,
  createCube,
  createFramebuffer,
  createProgram,
  createQuad,
  deleteFramebuffer,
  lookAt,
  multiply,
  perspective,
  resizeFramebuffer,
  rotationY,
  scaling,
  scaling3,
  setupGL,
  translation,
  type Framebuffer,
  type GLContext,
} from './gl'

/**
 * 水面：折射扰动 + 解析反射 + 菲涅尔
 *
 * 两趟：
 *  1) 先把池底与柱子渲染到离屏纹理（不含水面）；
 *  2) 水面片元按屏幕坐标偏移采样这张纹理（近似折射），再用反射向量采样解析天空色，
 *     最后按菲涅尔系数混合 —— 掠射角看到的是反射，俯视看到的是水下。
 *
 * 真实工程里反射要再开一台「镜像相机」渲一遍（并加剪裁平面挡掉水面以下），
 * 这里用解析天空代替，省一次几何 pass，视觉上够用。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

const waveHeight = ref(0.9)
const speed = ref(1)
const refractPower = ref(0.06)
const fresnelPower = ref(2.6)
const showWire = ref(false)
const stats = ref({ fps: 0 })

let sceneProg: WebGLProgram | null = null
let waterProg: WebGLProgram | null = null
let sceneFbo: Framebuffer | null = null
let quadBuf: WebGLBuffer | null = null
let cube = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let uScene: Record<string, WebGLUniformLocation | null> = {}
let uWater: Record<string, WebGLUniformLocation | null> = {}
let frames = 0
let lastFps = performance.now()

const VS = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vN = normalize(uNormalMat * aNormal);
  gl_Position = uProj * uView * w;
}
`

const FS_SCENE = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vWorld;
uniform vec3 uBase;
uniform float uTile;
void main() {
  // 池底格子：用世界坐标做棋盘，给「折射扰动」一个能看出来的参照
  vec2 g = floor(vWorld.xz * uTile);
  float checker = mod(g.x + g.y, 2.0);
  vec3 base = uBase * (0.78 + 0.22 * checker);
  vec3 N = normalize(vN);
  float diff = max(dot(N, normalize(vec3(0.4, 0.85, 0.35))), 0.0);
  gl_FragColor = vec4(base * (0.45 + 0.55 * diff), 1.0);
}
`

const FS_WATER = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;
uniform vec3 uCam;
uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uTime;
uniform float uWave;
uniform float uRefract;
uniform float uFresnel;
uniform float uWire;

// 波形梯度：几组方向不同的正弦叠加，返回 dh/dx、dh/dz
vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  g += vec2(0.9, 0.4) * cos(dot(p, vec2(0.9, 0.4)) * 1.7 + t * 1.6) * 0.35;
  g += vec2(-0.5, 0.8) * cos(dot(p, vec2(-0.5, 0.8)) * 2.3 + t * 2.1) * 0.22;
  g += vec2(0.2, -0.9) * cos(dot(p, vec2(0.2, -0.9)) * 3.9 + t * 2.7) * 0.12;
  return g;
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uRes;
  vec2 p = vUv * 8.0;
  vec2 grad = waveGrad(p, uTime) * uWave;
  vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));

  // 近似折射：按法线水平分量偏移屏幕坐标再采样场景纹理
  vec2 uv = screenUv + grad * uRefract;
  vec3 refracted = texture2D(uScene, clamp(uv, 0.001, 0.999)).rgb;

  // 反射：反射向量采样解析天空（顶部偏蓝、地平线偏白，外加一个太阳）
  vec3 I = normalize(vec3(screenUv * 2.0 - 1.0, -1.4));
  vec3 R = reflect(I, N);
  float sky = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 reflected = mix(vec3(0.42, 0.5, 0.62), vec3(0.14, 0.3, 0.58), sky);
  float sun = pow(max(dot(R, normalize(vec3(0.45, 0.72, 0.35))), 0.0), 220.0);
  reflected += vec3(1.0, 0.94, 0.8) * sun * 1.3;

  // 菲涅尔：用真实视线方向，视线越平反射越强（俯视时只剩水下）
  vec3 V = normalize(uCam - vWorld);
  float fres = pow(1.0 - max(dot(N, V), 0.0), uFresnel);
  fres = mix(0.08, 0.95, clamp(fres, 0.0, 1.0));

  // 水体吸收：水下部分偏深青，越靠反射越干净
  vec3 water = mix(vec3(0.03, 0.19, 0.22), refracted * vec3(0.55, 0.86, 0.9), 0.62);
  vec3 col = mix(water, reflected, fres);

  if (uWire > 0.5) {
    float l = fract(length(grad) * 24.0);
    col = mix(vec3(0.05, 0.12, 0.2), vec3(0.4, 0.9, 1.0), smoothstep(0.0, 0.08, l) * 0.6);
  }
  gl_FragColor = vec4(col, 1.0);
}
`

const WATER_VS = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
varying vec3 vWorld;
uniform mat4 uProj;
uniform mat4 uView;
void main() {
  // 水面：xz 平面上一块 14×14 的方板，y = 0
  vec3 p = vec3(aPos.x * 7.0, 0.0, aPos.y * 7.0);
  vWorld = p;
  vUv = aPos * 0.5 + 0.5;
  gl_Position = uProj * uView * vec4(p, 1.0);
}
`

function compile() {
  const gl = ctx!.gl
  sceneProg = createProgram(gl, VS, FS_SCENE)
  waterProg = createProgram(gl, WATER_VS, FS_WATER)
  if (!sceneProg || !waterProg) return false
  uScene = {
    uProj: gl.getUniformLocation(sceneProg, 'uProj'),
    uView: gl.getUniformLocation(sceneProg, 'uView'),
    uModel: gl.getUniformLocation(sceneProg, 'uModel'),
    uNormalMat: gl.getUniformLocation(sceneProg, 'uNormalMat'),
    uBase: gl.getUniformLocation(sceneProg, 'uBase'),
    uTile: gl.getUniformLocation(sceneProg, 'uTile'),
  }
  uWater = {
    uScene: gl.getUniformLocation(waterProg, 'uScene'),
    uRes: gl.getUniformLocation(waterProg, 'uRes'),
    uTime: gl.getUniformLocation(waterProg, 'uTime'),
    uWave: gl.getUniformLocation(waterProg, 'uWave'),
    uRefract: gl.getUniformLocation(waterProg, 'uRefract'),
    uFresnel: gl.getUniformLocation(waterProg, 'uFresnel'),
    uWire: gl.getUniformLocation(waterProg, 'uWire'),
    uCam: gl.getUniformLocation(waterProg, 'uCam'),
    uProj: gl.getUniformLocation(waterProg, 'uProj'),
    uView: gl.getUniformLocation(waterProg, 'uView'),
  }
  return true
}

function buildGeometry() {
  const gl = ctx!.gl
  const c = createCube()
  cube.count = c.indices.length
  cube.pos = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, cube.pos)
  gl.bufferData(gl.ARRAY_BUFFER, c.positions, gl.STATIC_DRAW)
  cube.nrm = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, cube.nrm)
  gl.bufferData(gl.ARRAY_BUFFER, c.normals, gl.STATIC_DRAW)
  cube.idx = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.idx)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, c.indices, gl.STATIC_DRAW)
  quadBuf = createQuad(gl)
}

function render(now: number) {
  if (!ctx || !sceneProg || !waterProg || !sceneFbo) return
  const gl = ctx!.gl
  const t = now * 0.001 * speed.value
  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 120)
  const view = lookAt([0, 3.1, 7.4], [0, 0.2, 0], [0, 1, 0])

  /* 1) 池底与柱子 → 离屏 */
  bindFramebuffer(gl, sceneFbo, ctx!.canvas.width, ctx!.canvas.height)
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.03, 0.05, 0.07, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.useProgram(sceneProg)
  gl.uniformMatrix4fv(uScene.uProj, false, proj)
  gl.uniformMatrix4fv(uScene.uView, false, view)

  gl.bindBuffer(gl.ARRAY_BUFFER, cube.pos)
  const aPos = gl.getAttribLocation(sceneProg, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, cube.nrm)
  const aNrm = gl.getAttribLocation(sceneProg, 'aNormal')
  gl.enableVertexAttribArray(aNrm)
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.idx)

  const drawBox = (m: Float32Array, color: [number, number, number], tile: number) => {
    const nm = new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
    gl.uniformMatrix4fv(uScene.uModel, false, m)
    gl.uniformMatrix3fv(uScene.uNormalMat, false, nm)
    gl.uniform3f(uScene.uBase, color[0], color[1], color[2])
    gl.uniform1f(uScene.uTile, tile)
    gl.drawElements(gl.TRIANGLES, cube.count, gl.UNSIGNED_SHORT, 0)
  }

  // 池底
  drawBox(multiply(translation(0, -1.3, 0), scaling3(7, 0.1, 7)), [0.34, 0.36, 0.32], 3.0)
  // 柱子
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4
    drawBox(
      multiply(
        multiply(translation(Math.cos(a) * 2.6, -0.35, Math.sin(a) * 2.6), rotationY(a)),
        scaling3(0.42, 1.05, 0.42),
      ),
      [0.62, 0.58, 0.5],
      1.0,
    )
  }
  gl.disable(gl.DEPTH_TEST)

  /* 2) 水面 */
  bindFramebuffer(gl, null, ctx!.canvas.width, ctx!.canvas.height)
  gl.clearColor(0.03, 0.05, 0.07, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(waterProg)
  gl.uniformMatrix4fv(uWater.uProj, false, proj)
  gl.uniformMatrix4fv(uWater.uView, false, view)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, sceneFbo.tex)
  gl.uniform1i(uWater.uScene, 0)
  gl.uniform2f(uWater.uRes, ctx!.canvas.width, ctx!.canvas.height)
  gl.uniform1f(uWater.uTime, t)
  gl.uniform1f(uWater.uWave, waveHeight.value)
  gl.uniform1f(uWater.uRefract, refractPower.value)
  gl.uniform1f(uWater.uFresnel, fresnelPower.value)
  gl.uniform3f(uWater.uCam, 0, 3.1, 7.4)
  gl.uniform1f(uWater.uWire, showWire.value ? 1 : 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  const qp = gl.getAttribLocation(waterProg, 'aPos')
  gl.enableVertexAttribArray(qp)
  gl.vertexAttribPointer(qp, 2, gl.FLOAT, false, 0, 0)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

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
  sceneFbo = createFramebuffer(ctx.gl, ctx.canvas.width, ctx.canvas.height, true)
  raf = requestAnimationFrame(render)

  const onResize = () => {
    ctx!.resize()
    if (sceneFbo) resizeFramebuffer(ctx!.gl, sceneFbo, ctx!.canvas.width, ctx!.canvas.height)
  }
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    deleteFramebuffer(gl, sceneFbo)
    for (const p of [sceneProg, waterProg]) if (p) gl.deleteProgram(p)
    if (quadBuf) gl.deleteBuffer(quadBuf)
    for (const b of [cube.pos, cube.nrm, cube.idx]) if (b) gl.deleteBuffer(b)
  }
  ctx = null
  sceneFbo = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">水面 · 折射扰动 + 菲涅尔反射</div>
      <div class="sub">先渲池底到离屏，再让水面采样它 · {{ stats.fps }} fps</div>

      <div class="ctrl">
        <span class="lab">波高</span>
        <input v-model.number="waveHeight" type="range" min="0" max="1.6" step="0.02" />
        <b>{{ waveHeight.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">流速</span>
        <input v-model.number="speed" type="range" min="0" max="3" step="0.05" />
        <b>{{ speed.toFixed(2) }}<i>×</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">折射强度</span>
        <input v-model.number="refractPower" type="range" min="0" max="0.12" step="0.002" />
        <b>{{ refractPower.toFixed(3) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">菲涅尔</span>
        <input v-model.number="fresnelPower" type="range" min="1" max="8" step="0.1" />
        <b>{{ fresnelPower.toFixed(1) }}</b>
      </div>
      <button class="chip" :class="{ on: showWire }" @click="showWire = !showWire">
        {{ showWire ? '隐藏波形' : '查看波形梯度' }}
      </button>

      <div class="tip">
        水面本身不写深度、也不参与池底的渲染：先把池底 + 柱子渲到离屏纹理，
        水面片元按屏幕坐标加扰动再采样它（近似折射），反射则用反射向量采样解析天空。
        菲涅尔决定「看远处像镜子、看脚下像玻璃」的比例。
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
  background: #05080c;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 312px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(10, 16, 24, 0.9);
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
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.lab {
  flex: 0 0 62px;
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
  background: #5fd0e6;
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
  background: #5fd0e6;
  border-color: #5fd0e6;
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
</style>
