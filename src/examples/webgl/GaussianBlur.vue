<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  setupGL,
  translation,
  type Framebuffer,
  type GLContext,
} from './gl'

/**
 * 两趟可分离高斯模糊
 *
 * 二维高斯是「行 × 列」可分离的：N×N 的卷积核拆成两次 1D，采样数从 N² 降到 2N。
 * 这里再叠两个工程手段：
 *   - 降采样：模糊本身就是低通，先在 1/2 或 1/4 分辨率上做，采样成本降到 1/4、1/16；
 *   - 多次迭代：半径受循环上限约束，用「小核多跑几遍」近似大核（等效 sigma 按 √n 增长）。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

const radius = ref(6)
const iterations = ref(1)
const downscale = ref(2)
const split = ref(0.5) // 0 = 全模糊，1 = 全清晰
const stats = ref({ passes: 0, samples: 0, fps: 0 })

let sceneProg: WebGLProgram | null = null
let blurProg: WebGLProgram | null = null
let compProg: WebGLProgram | null = null
let sceneFbo: Framebuffer | null = null
let blurA: Framebuffer | null = null
let blurB: Framebuffer | null = null
let quadBuf: WebGLBuffer | null = null
let cube = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let uBlur: Record<string, WebGLUniformLocation | null> = {}
let uComp: Record<string, WebGLUniformLocation | null> = {}
let uScene: Record<string, WebGLUniformLocation | null> = {}
let frames = 0
let lastFps = performance.now()

const sceneVs = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  gl_Position = uProj * uView * world;
}
`

const sceneFs = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vWorld;
uniform vec3 uColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.5, 0.9, 0.7));
  float diff = max(dot(n, lightDir), 0.0);
  float spec = pow(max(dot(reflect(-lightDir, n), vec3(0.0, 0.0, 1.0)), 0.0), 32.0);
  // 一点条纹，让模糊的方向性看得出来
  float stripe = 0.85 + 0.15 * sin(vWorld.y * 6.0);
  vec3 c = uColor * (0.28 + 0.72 * diff) * stripe + spec * 0.45;
  gl_FragColor = vec4(c, 1.0);
}
`

const blurVs = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const blurFs = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;      // 采样方向（水平或垂直），已按纹理尺寸归一化
uniform float uRadius;
uniform float uSigma;

void main() {
  vec4 sum = texture2D(uTex, vUv);
  float wsum = 1.0;
  // GLSL ES 1.0 的循环边界必须是常量，这里固定 16 次、用 break 控制有效半径
  for (int i = 1; i <= 16; i++) {
    float fi = float(i);
    if (fi > uRadius) break;
    float w = exp(-(fi * fi) / (2.0 * uSigma * uSigma));
    sum += texture2D(uTex, vUv + uDir * fi) * w;
    sum += texture2D(uTex, vUv - uDir * fi) * w;
    wsum += w * 2.0;
  }
  gl_FragColor = sum / wsum;
}
`

const compFs = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSharp;
uniform sampler2D uBlur;
uniform float uSplit;
void main() {
  vec3 sharp = texture2D(uSharp, vUv).rgb;
  vec3 blur = texture2D(uBlur, vUv).rgb;
  // 左半清晰、右半模糊，中间一条细线方便对比
  float m = step(uSplit, vUv.x);
  vec3 c = mix(sharp, blur, m);
  float edge = 1.0 - smoothstep(0.0, 0.0015, abs(vUv.x - uSplit));
  c = mix(c, vec3(0.35, 0.75, 1.0), edge * 0.8);
  gl_FragColor = vec4(c, 1.0);
}
`

function compile() {
  const gl = ctx!.gl
  sceneProg = createProgram(gl, sceneVs, sceneFs)
  blurProg = createProgram(gl, blurVs, blurFs)
  compProg = createProgram(gl, blurVs, compFs)
  if (!sceneProg || !blurProg || !compProg) return false
  uScene = {
    uProj: gl.getUniformLocation(sceneProg, 'uProj'),
    uView: gl.getUniformLocation(sceneProg, 'uView'),
    uModel: gl.getUniformLocation(sceneProg, 'uModel'),
    uNormalMat: gl.getUniformLocation(sceneProg, 'uNormalMat'),
    uColor: gl.getUniformLocation(sceneProg, 'uColor'),
  }
  uBlur = {
    uTex: gl.getUniformLocation(blurProg, 'uTex'),
    uDir: gl.getUniformLocation(blurProg, 'uDir'),
    uRadius: gl.getUniformLocation(blurProg, 'uRadius'),
    uSigma: gl.getUniformLocation(blurProg, 'uSigma'),
  }
  uComp = {
    uSharp: gl.getUniformLocation(compProg, 'uSharp'),
    uBlur: gl.getUniformLocation(compProg, 'uBlur'),
    uSplit: gl.getUniformLocation(compProg, 'uSplit'),
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

function allocTargets() {
  const gl = ctx!.gl
  const w = ctx!.canvas.width
  const h = ctx!.canvas.height
  deleteFramebuffer(gl, sceneFbo)
  deleteFramebuffer(gl, blurA)
  deleteFramebuffer(gl, blurB)
  sceneFbo = createFramebuffer(gl, w, h, true)
  const s = Math.max(1, Math.round(1 / downscale.value))
  const bw = Math.max(1, Math.floor(w * s))
  const bh = Math.max(1, Math.floor(h * s))
  blurA = createFramebuffer(gl, bw, bh, false)
  blurB = createFramebuffer(gl, bw, bh, false)
}

function drawQuad(prog: WebGLProgram) {
  const gl = ctx!.gl
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

/** 一趟模糊：从 src 读、写 dst，dir 为 (1,0) 或 (0,1) */
function blurPass(src: Framebuffer, dst: Framebuffer, horizontal: boolean, r: number) {
  const gl = ctx!.gl
  bindFramebuffer(gl, dst, ctx!.canvas.width, ctx!.canvas.height)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  const prog = blurProg!
  gl.useProgram(prog)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, src.tex)
  gl.uniform1i(uBlur.uTex, 0)
  // 采样步长按源纹理的像素尺寸算，半径就是"几个像素"
  gl.uniform2f(uBlur.uDir, horizontal ? 1 / src.width : 0, horizontal ? 0 : 1 / src.height)
  gl.uniform1f(uBlur.uRadius, r)
  gl.uniform1f(uBlur.uSigma, Math.max(0.6, r / 3))
  drawQuad(prog)
}

function render(now: number) {
  if (!ctx || !sceneProg || !blurProg || !compProg || !sceneFbo || !blurA || !blurB) return
  const gl = ctx!.gl
  const t = now * 0.001

  /* 1) 场景 → 离屏 */
  bindFramebuffer(gl, sceneFbo, ctx!.canvas.width, ctx!.canvas.height)
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.04, 0.05, 0.08, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((52 * Math.PI) / 180, aspect, 0.1, 100)
  const view = lookAt([0, 4.2, 12.5], [0, 0.6, 0], [0, 1, 0])

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

  const palette = [
    [0.95, 0.36, 0.32],
    [0.98, 0.72, 0.3],
    [0.42, 0.82, 0.55],
    [0.36, 0.68, 0.96],
    [0.72, 0.5, 0.95],
  ]
  let k = 0
  for (let z = -2; z <= 2; z++) {
    for (let x = -2; x <= 2; x++) {
      const m = multiply(
        multiply(translation(x * 2.1, Math.sin(t * 0.8 + (x + z) * 0.5) * 0.25, z * 2.1), rotationY(t * 0.5 + k * 0.4)),
        scaling(0.42),
      )
      // 法线矩阵：这里只有旋转+均匀缩放，直接用模型矩阵的旋转部分即可
      const nm = new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
      gl.uniformMatrix4fv(uScene.uModel, false, m)
      gl.uniformMatrix3fv(uScene.uNormalMat, false, nm)
      const c = palette[k % palette.length]
      gl.uniform3f(uScene.uColor, c[0], c[1], c[2])
      gl.drawElements(gl.TRIANGLES, cube.count, gl.UNSIGNED_SHORT, 0)
      k++
    }
  }
  gl.disable(gl.DEPTH_TEST)

  /* 2) 可分离模糊：H → V，迭代 N 次（最后一次落在 blurA） */
  const r = radius.value
  const n = Math.max(1, iterations.value)
  let src = sceneFbo
  for (let i = 0; i < n; i++) {
    // 乒乓：H 写 A，V 写 B，下一轮把 B 当输入再走一遍，等效 sigma 按 √n 增长
    blurPass(src, blurA, true, r)
    blurPass(blurA, blurB, false, r)
    src = blurB
  }
  const blurred = src

  /* 3) 合成：左清晰右模糊 */
  bindFramebuffer(gl, null, ctx!.canvas.width, ctx!.canvas.height)
  const prog = compProg!
  gl.useProgram(prog)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, sceneFbo.tex)
  gl.uniform1i(uComp.uSharp, 0)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, blurred.tex)
  gl.uniform1i(uComp.uBlur, 1)
  gl.uniform1f(uComp.uSplit, split.value)
  drawQuad(prog)

  stats.value.passes = n * 2
  stats.value.samples = n * 2 * (Math.min(16, Math.round(r)) * 2 + 1)
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
  allocTargets()
  raf = requestAnimationFrame(render)

  const onResize = () => {
    ctx!.resize()
    allocTargets()
  }
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

watch(downscale, () => ctx && allocTargets())
watch(radius, () => undefined)
watch(iterations, () => undefined)

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    deleteFramebuffer(gl, sceneFbo)
    deleteFramebuffer(gl, blurA)
    deleteFramebuffer(gl, blurB)
    if (sceneProg) gl.deleteProgram(sceneProg)
    if (blurProg) gl.deleteProgram(blurProg)
    if (compProg) gl.deleteProgram(compProg)
    if (quadBuf) gl.deleteBuffer(quadBuf)
    for (const b of [cube.pos, cube.nrm, cube.idx]) if (b) gl.deleteBuffer(b)
  }
  ctx = null
  sceneFbo = blurA = blurB = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">两趟可分离高斯模糊</div>
      <div class="sub">
        {{ stats.passes }} 趟 · 每像素 {{ stats.samples }} 次采样 · {{ stats.fps }} fps
      </div>

      <div class="ctrl">
        <span class="lab">模糊半径</span>
        <input v-model.number="radius" type="range" min="1" max="16" step="1" />
        <b>{{ radius }}<i>px</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">迭代次数</span>
        <input v-model.number="iterations" type="range" min="1" max="3" step="1" />
        <b>{{ iterations }}<i>次</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">对比位置</span>
        <input v-model.number="split" type="range" min="0" max="1" step="0.01" />
        <b>{{ Math.round(split * 100) }}%</b>
      </div>
      <div class="row">
        <span class="lab">降采样</span>
        <button
          v-for="s in [1, 2, 4]"
          :key="s"
          class="chip"
          :class="{ on: downscale === s }"
          @click="downscale = s"
        >
          1/{{ s }}
        </button>
      </div>

      <div class="tip">
        二维高斯拆成两次 1D（采样 N² → 2N），再在 1/2 或 1/4 分辨率上做——模糊本身就是低通，
        降采样几乎不损失结果，成本却降到 1/4、1/16。采样权重用 <code>exp(-x²/2σ²)</code>，
        GLSL ES 1.0 的循环边界必须是常量，所以固定 16 次、用 <code>break</code> 控制有效半径。
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
  background: #0a0e16;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 322px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(14, 20, 28, 0.9);
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
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
}
.chip {
  padding: 3px 9px;
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
