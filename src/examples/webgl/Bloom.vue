<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  bindFramebuffer,
  createFramebuffer,
  createProgram,
  createQuad,
  createSphere,
  deleteFramebuffer,
  lookAt,
  multiply,
  perspective,
  rotationY,
  scaling,
  setupGL,
  translation,
  type Framebuffer,
  type GLContext,
} from './gl'

/**
 * 泛光（Bloom）
 *
 * 三步：亮部提取 → 模糊 → 加法合成。真实引擎里这一步在 HDR 空间做（颜色可以大于 1），
 * 这里用 LDR + 软阈值近似：亮于阈值的像素按超出量加权后取出来单独糊，再叠回原图。
 * 模糊用的是和「两趟高斯」相同的可分离卷积，只是降到 1/4 分辨率跑，够糊也够快。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

const threshold = ref(0.38)
const intensity = ref(1.35)
const radius = ref(26)
const enabled = ref(true)
const stats = ref({ fps: 0 })

let sceneProg: WebGLProgram | null = null
let brightProg: WebGLProgram | null = null
let blurProg: WebGLProgram | null = null
let compProg: WebGLProgram | null = null
let sceneFbo: Framebuffer | null = null
let brightFbo: Framebuffer | null = null
let blurA: Framebuffer | null = null
let blurB: Framebuffer | null = null
let quadBuf: WebGLBuffer | null = null
let sphere = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let uScene: Record<string, WebGLUniformLocation | null> = {}
let uBright: Record<string, WebGLUniformLocation | null> = {}
let uBlur: Record<string, WebGLUniformLocation | null> = {}
let uComp: Record<string, WebGLUniformLocation | null> = {}
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
varying vec3 vPos;
void main() {
  vNormal = normalize(uNormalMat * aNormal);
  vPos = aPos;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}
`

const sceneFs = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vPos;
uniform vec3 uColor;
uniform float uEmissive;
void main() {
  vec3 n = normalize(vNormal);
  vec3 L = normalize(vec3(0.4, 0.8, 0.6));
  float diff = max(dot(n, L), 0.0);
  float rim = pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
  // 自发光球：基色本身就很亮，边缘再亮一圈，泛光才好看
  vec3 c = uColor * (0.15 + 0.35 * diff) + uColor * uEmissive + vec3(rim * uEmissive * 0.6);
  gl_FragColor = vec4(c, 1.0);
}
`

const quadVs = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const brightFs = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // 软阈值：低于阈值取 0，高于阈值按超出量保留，避免硬边
  float w = max(l - uThreshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(c * w, 1.0);
}
`

const blurFs = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uRadius;
uniform float uSigma;
void main() {
  vec4 sum = texture2D(uTex, vUv);
  float wsum = 1.0;
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
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uIntensity;
uniform float uOn;
void main() {
  vec3 base = texture2D(uScene, vUv).rgb;
  vec3 bloom = texture2D(uBloom, vUv).rgb;
  // 加法混合而不是 lerp：光该叠加，不该替换
  vec3 c = base + bloom * uIntensity * uOn;
  // 简单色调压缩，避免叠加后死白一片
  c = c / (1.0 + max(c - 1.0, 0.0) * 0.6);
  gl_FragColor = vec4(c, 1.0);
}
`

function compile() {
  const gl = ctx!.gl
  sceneProg = createProgram(gl, sceneVs, sceneFs)
  brightProg = createProgram(gl, quadVs, brightFs)
  blurProg = createProgram(gl, quadVs, blurFs)
  compProg = createProgram(gl, quadVs, compFs)
  if (!sceneProg || !brightProg || !blurProg || !compProg) return false
  uScene = {
    uProj: gl.getUniformLocation(sceneProg, 'uProj'),
    uView: gl.getUniformLocation(sceneProg, 'uView'),
    uModel: gl.getUniformLocation(sceneProg, 'uModel'),
    uNormalMat: gl.getUniformLocation(sceneProg, 'uNormalMat'),
    uColor: gl.getUniformLocation(sceneProg, 'uColor'),
    uEmissive: gl.getUniformLocation(sceneProg, 'uEmissive'),
  }
  uBright = {
    uTex: gl.getUniformLocation(brightProg, 'uTex'),
    uThreshold: gl.getUniformLocation(brightProg, 'uThreshold'),
  }
  uBlur = {
    uTex: gl.getUniformLocation(blurProg, 'uTex'),
    uDir: gl.getUniformLocation(blurProg, 'uDir'),
    uRadius: gl.getUniformLocation(blurProg, 'uRadius'),
    uSigma: gl.getUniformLocation(blurProg, 'uSigma'),
  }
  uComp = {
    uScene: gl.getUniformLocation(compProg, 'uScene'),
    uBloom: gl.getUniformLocation(compProg, 'uBloom'),
    uIntensity: gl.getUniformLocation(compProg, 'uIntensity'),
    uOn: gl.getUniformLocation(compProg, 'uOn'),
  }
  return true
}

function buildGeometry() {
  const gl = ctx!.gl
  const s = createSphere(32, 20)
  sphere.count = s.indices.length
  sphere.pos = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.pos)
  gl.bufferData(gl.ARRAY_BUFFER, s.positions, gl.STATIC_DRAW)
  sphere.nrm = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.nrm)
  gl.bufferData(gl.ARRAY_BUFFER, s.normals, gl.STATIC_DRAW)
  sphere.idx = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphere.idx)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, s.indices, gl.STATIC_DRAW)
  quadBuf = createQuad(gl)
}

function allocTargets() {
  const gl = ctx!.gl
  const w = ctx!.canvas.width
  const h = ctx!.canvas.height
  for (const f of [sceneFbo, brightFbo, blurA, blurB]) deleteFramebuffer(gl, f)
  const bw = Math.max(1, Math.floor(w / 4))
  const bh = Math.max(1, Math.floor(h / 4))
  sceneFbo = createFramebuffer(gl, w, h, true)
  brightFbo = createFramebuffer(gl, bw, bh, false)
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

function blurPass(src: Framebuffer, dst: Framebuffer, horizontal: boolean, r: number) {
  const gl = ctx!.gl
  bindFramebuffer(gl, dst, ctx!.canvas.width, ctx!.canvas.height)
  gl.clear(gl.COLOR_BUFFER_BIT)
  const prog = blurProg!
  gl.useProgram(prog)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, src.tex)
  gl.uniform1i(uBlur.uTex, 0)
  gl.uniform2f(uBlur.uDir, horizontal ? 1 / src.width : 0, horizontal ? 0 : 1 / src.height)
  gl.uniform1f(uBlur.uRadius, r)
  gl.uniform1f(uBlur.uSigma, Math.max(0.7, r / 2.6))
  drawQuad(prog)
}

function render(now: number) {
  if (!ctx || !sceneProg || !sceneFbo || !brightFbo || !blurA || !blurB) return
  const gl = ctx!.gl
  const t = now * 0.001

  /* 1) 场景 */
  bindFramebuffer(gl, sceneFbo, ctx!.canvas.width, ctx!.canvas.height)
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.015, 0.02, 0.03, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 100)
  const view = lookAt([0, 2.6, 9.2], [0, 0.2, 0], [0, 1, 0])
  gl.useProgram(sceneProg)
  gl.uniformMatrix4fv(uScene.uProj, false, proj)
  gl.uniformMatrix4fv(uScene.uView, false, view)

  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.pos)
  const aPos = gl.getAttribLocation(sceneProg, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.nrm)
  const aNrm = gl.getAttribLocation(sceneProg, 'aNormal')
  gl.enableVertexAttribArray(aNrm)
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphere.idx)

  // 自发光别给太满：超过 1 就压成纯白，颜色和明暗都丢了
  const balls = [
    { p: [-2.4, 0.55, 0], c: [0.25, 0.75, 1.0], s: 0.55, e: 0.55 },
    { p: [0, 0.9, -1.1], c: [1.0, 0.42, 0.32], s: 0.8, e: 0.75 },
    { p: [2.5, 0.45, 0.2], c: [1.0, 0.82, 0.28], s: 0.5, e: 0.6 },
    { p: [1.3, 1.7, 0.8], c: [0.72, 0.42, 1.0], s: 0.34, e: 0.7 },
    { p: [-1.4, 1.9, 0.9], c: [0.36, 1.0, 0.7], s: 0.28, e: 0.5 },
  ] as const
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]
    const bob = Math.sin(t * 1.1 + i) * 0.08
    const m = multiply(
      multiply(translation(b.p[0], b.p[1] + bob, b.p[2]), rotationY(t * 0.4 + i)),
      scaling(b.s),
    )
    const nm = new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
    gl.uniformMatrix4fv(uScene.uModel, false, m)
    gl.uniformMatrix3fv(uScene.uNormalMat, false, nm)
    gl.uniform3f(uScene.uColor, b.c[0], b.c[1], b.c[2])
    gl.uniform1f(uScene.uEmissive, b.e)
    gl.drawElements(gl.TRIANGLES, sphere.count, gl.UNSIGNED_SHORT, 0)
  }
  gl.disable(gl.DEPTH_TEST)

  /* 2) 亮部提取（降到 1/4） */
  bindFramebuffer(gl, brightFbo, ctx!.canvas.width, ctx!.canvas.height)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(brightProg!)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, sceneFbo.tex)
  gl.uniform1i(uBright.uTex, 0)
  gl.uniform1f(uBright.uThreshold, threshold.value)
  drawQuad(brightProg!)

  /* 3) 两趟模糊（1/4 分辨率，半径小也够糊） */
  const r = Math.min(16, Math.max(1, Math.round(radius.value / 4)))
  blurPass(brightFbo, blurA, true, r)
  blurPass(blurA, blurB, false, r)
  blurPass(blurB, blurA, true, r)
  blurPass(blurA, blurB, false, r)

  /* 4) 合成 */
  bindFramebuffer(gl, null, ctx!.canvas.width, ctx!.canvas.height)
  gl.useProgram(compProg!)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, sceneFbo.tex)
  gl.uniform1i(uComp.uScene, 0)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, blurB.tex)
  gl.uniform1i(uComp.uBloom, 1)
  gl.uniform1f(uComp.uIntensity, intensity.value)
  gl.uniform1f(uComp.uOn, enabled.value ? 1 : 0)
  drawQuad(compProg!)

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

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    for (const f of [sceneFbo, brightFbo, blurA, blurB]) deleteFramebuffer(gl, f)
    for (const p of [sceneProg, brightProg, blurProg, compProg]) if (p) gl.deleteProgram(p)
    if (quadBuf) gl.deleteBuffer(quadBuf)
    for (const b of [sphere.pos, sphere.nrm, sphere.idx]) if (b) gl.deleteBuffer(b)
  }
  ctx = null
  sceneFbo = brightFbo = blurA = blurB = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">泛光 Bloom · 亮部提取 + 模糊 + 加法合成</div>
      <div class="sub">4 趟模糊（1/4 分辨率）· {{ stats.fps }} fps</div>

      <div class="ctrl">
        <span class="lab">亮度阈值</span>
        <input v-model.number="threshold" type="range" min="0.2" max="1.2" step="0.02" />
        <b>{{ threshold.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">泛光强度</span>
        <input v-model.number="intensity" type="range" min="0" max="2.4" step="0.05" />
        <b>{{ intensity.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">扩散半径</span>
        <input v-model.number="radius" type="range" min="4" max="48" step="2" />
        <b>{{ radius }}<i>px</i></b>
      </div>
      <button class="chip" :class="{ on: enabled }" @click="enabled = !enabled">
        {{ enabled ? '关闭泛光对比' : '开启泛光' }}
      </button>

      <div class="tip">
        光用<b>加法</b>叠加（base + bloom × 强度），不是 lerp 替换；提取用软阈值，
        低于阈值全黑、高于阈值按超出量保留，边缘才不会硬。模糊在 1/4 分辨率上做，
        成本和效果都够用——真实引擎会把这一步放进 HDR 空间（颜色可大于 1）。
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
  background: #05070b;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 316px;
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
.tip b {
  color: #cfe4f5;
}
</style>
