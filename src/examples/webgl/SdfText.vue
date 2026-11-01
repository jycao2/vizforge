<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createProgram, setupGL, textureFromCanvas, type GLContext } from './gl'

/**
 * SDF 文字（有向距离场）
 *
 * 普通字体图集放大就糊，是因为纹理里存的是「像素颜色」。SDF 存的是「到字形边缘的距离」，
 * 渲染时用 smoothstep 在 0.5 附近切一刀 —— 无论放多大，边缘都一样锐利，
 * 而且描边、外发光、阴影全都是同一张图上多切一刀，不增加任何纹理。
 *
 * 这里在运行时生成：canvas 写字 → 二值掩膜 → 双向 chamfer 距离变换 → 归一化成 0~1。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null

const zoom = ref(1)
const outline = ref(0.06)
const softness = ref(0.02)
const showSdf = ref(false)
const TEXT = 'SDF'

let prog: WebGLProgram | null = null
let quad: WebGLBuffer | null = null
let sdfTex: WebGLTexture | null = null
let u: Record<string, WebGLUniformLocation | null> = {}
const TEX_W = 512
const TEX_H = 256
const SPREAD = 24 // 距离场的影响半径（像素），决定 0~1 的映射范围

/** 画字 → 二值掩膜 */
function makeMask(): Uint8Array {
  const cv = document.createElement('canvas')
  cv.width = TEX_W
  cv.height = TEX_H
  const g = cv.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, TEX_W, TEX_H)
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `bold 150px "Helvetica Neue", Arial, sans-serif`
  g.fillText(TEXT, TEX_W / 2, TEX_H / 2 + 4)

  const data = g.getImageData(0, 0, TEX_W, TEX_H).data
  const mask = new Uint8Array(TEX_W * TEX_H)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] > 127 ? 1 : 0
  return mask
}

/**
 * 双向 chamfer 距离变换（3-4 近似欧氏距离）
 * inside = true 时求「内部像素到外部」的距离，否则求「外部到内部」
 */
function chamfer(mask: Uint8Array, inside: boolean): Float32Array {
  const INF = 1e6
  const d = new Float32Array(TEX_W * TEX_H)
  for (let i = 0; i < d.length; i++) {
    const isIn = mask[i] === 1
    d[i] = inside ? (isIn ? INF : 0) : isIn ? 0 : INF
  }
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= TEX_W || y >= TEX_H ? INF : d[y * TEX_W + x])
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= TEX_W || y >= TEX_H) return
    d[y * TEX_W + x] = v
  }
  // 正向
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const i = y * TEX_W + x
      let v = d[i]
      if (v === 0) continue
      v = Math.min(v, at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414)
      d[i] = v
    }
  }
  // 反向
  for (let y = TEX_H - 1; y >= 0; y--) {
    for (let x = TEX_W - 1; x >= 0; x--) {
      const i = y * TEX_W + x
      let v = d[i]
      if (v === 0) continue
      v = Math.min(v, at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414)
      d[i] = v
    }
  }
  return d
}

/** 掩膜 → SDF 纹理（0.5 是边缘，内侧 > 0.5） */
function makeSdfCanvas(mask: Uint8Array): HTMLCanvasElement {
  const dIn = chamfer(mask, true) // 内部到外部
  const dOut = chamfer(mask, false) // 外部到内部
  const cv = document.createElement('canvas')
  cv.width = TEX_W
  cv.height = TEX_H
  const g = cv.getContext('2d')!
  const img = g.createImageData(TEX_W, TEX_H)
  for (let i = 0; i < mask.length; i++) {
    const signed = mask[i] ? dIn[i] : -dOut[i]
    const v = Math.max(0, Math.min(255, Math.round((0.5 + signed / (2 * SPREAD)) * 255)))
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return cv
}

const VS = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSdf;
uniform vec2 uRes;
uniform float uZoom;
uniform float uOutline;
uniform float uSoft;
uniform float uShowSdf;
uniform vec2 uTexRes;

void main() {
  // 背景：一点渐变，方便看描边
  vec3 bg = mix(vec3(0.05, 0.07, 0.11), vec3(0.1, 0.13, 0.19), vUv.y);

  // 按缩放把 uv 映射到纹理中心（zoom 越大字越大）
  vec2 uv = (vUv - 0.5) / uZoom + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(bg, 1.0);
    return;
  }
  // 保持纹理宽高比，不被屏幕拉伸
  float screenAspect = uRes.x / uRes.y;
  float texAspect = uTexRes.x / uTexRes.y;
  vec2 p = uv - 0.5;
  if (screenAspect > texAspect) p.x *= screenAspect / texAspect;
  else p.y *= texAspect / screenAspect;
  uv = p + 0.5;

  float d = texture2D(uSdf, uv).r;

  if (uShowSdf > 0.5) {
    gl_FragColor = vec4(vec3(d), 1.0);
    return;
  }

  // 边缘 = 距离场在 0.5 附近的那一层；uSoft 控制羽化宽度
  float aa = max(uSoft, 0.002);
  float fill = smoothstep(0.5 - aa, 0.5 + aa, d);
  // 描边：把阈值整体外移 uOutline
  float outer = smoothstep(0.5 - aa - uOutline, 0.5 + aa - uOutline, d);

  vec3 edgeColor = vec3(0.25, 0.85, 1.0);
  vec3 fillColor = vec3(0.95, 0.97, 1.0);
  vec3 col = bg;
  col = mix(col, edgeColor, outer);
  col = mix(col, fillColor, fill);

  gl_FragColor = vec4(col, 1.0);
}
`

function draw() {
  if (!ctx || !prog) return
  const gl = ctx!.gl
  gl.viewport(0, 0, ctx!.canvas.width, ctx!.canvas.height)
  gl.clearColor(0.05, 0.07, 0.11, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(prog)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, sdfTex)
  gl.uniform1i(u.uSdf, 0)
  gl.uniform2f(u.uRes, ctx!.canvas.width, ctx!.canvas.height)
  gl.uniform2f(u.uTexRes, TEX_W, TEX_H)
  gl.uniform1f(u.uZoom, zoom.value)
  gl.uniform1f(u.uOutline, outline.value)
  gl.uniform1f(u.uSoft, softness.value)
  gl.uniform1f(u.uShowSdf, showSdf.value ? 1 : 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

onMounted(() => {
  if (!container.value) return
  ctx = setupGL(container.value)
  if (!ctx) return
  const gl = ctx.gl
  prog = createProgram(gl, VS, FS)
  if (!prog) return
  u = {
    uSdf: gl.getUniformLocation(prog, 'uSdf'),
    uRes: gl.getUniformLocation(prog, 'uRes'),
    uZoom: gl.getUniformLocation(prog, 'uZoom'),
    uOutline: gl.getUniformLocation(prog, 'uOutline'),
    uSoft: gl.getUniformLocation(prog, 'uSoft'),
    uShowSdf: gl.getUniformLocation(prog, 'uShowSdf'),
    uTexRes: gl.getUniformLocation(prog, 'uTexRes'),
  }
  quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  sdfTex = textureFromCanvas(gl, makeSdfCanvas(makeMask()), true)
  draw()

  const onResize = () => {
    ctx!.resize()
    draw()
  }
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

watch([zoom, outline, softness, showSdf], draw)

onBeforeUnmount(() => {
  const gl = ctx?.gl
  if (gl) {
    if (prog) gl.deleteProgram(prog)
    if (quad) gl.deleteBuffer(quad)
    if (sdfTex) gl.deleteTexture(sdfTex)
  }
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">SDF 文字 · 距离场</div>
      <div class="sub">一张 {{ TEX_W }}×{{ TEX_H }} 的距离场纹理，任意缩放都锐利</div>

      <div class="ctrl">
        <span class="lab">缩放</span>
        <input v-model.number="zoom" type="range" min="0.6" max="6" step="0.05" />
        <b>{{ zoom.toFixed(2) }}<i>×</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">描边宽度</span>
        <input v-model.number="outline" type="range" min="0" max="0.3" step="0.005" />
        <b>{{ outline.toFixed(3) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">边缘羽化</span>
        <input v-model.number="softness" type="range" min="0.002" max="0.12" step="0.002" />
        <b>{{ softness.toFixed(3) }}</b>
      </div>
      <button class="chip" :class="{ on: showSdf }" @click="showSdf = !showSdf">
        {{ showSdf ? '返回文字' : '查看距离场' }}
      </button>

      <div class="tip">
        纹理里存的不是颜色，而是「到字形边缘的距离」：边缘正好 0.5，内部大于 0.5。
        渲染时 <code>smoothstep(0.5-aa, 0.5+aa, d)</code> 切一刀就是字，把阈值整体外移
        就是描边 —— 放大六倍边缘依然锐利，因为插值的是距离不是像素。
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
