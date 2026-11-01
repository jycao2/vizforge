<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createProgram, setupGL, type GLContext } from './gl'

/**
 * 图像滤镜链（单趟全屏 shader）
 *
 * 这是 WebGL 最高频的用法：把图片当纹理，一个 fragment shader 里串起
 * 亮度 / 对比度 / 饱和度 / 色相 / 色调分离 / 暗角，参数实时可调。
 * 关键点：亮度按 Rec.709 权重（0.2126/0.7152/0.0722）算，不是 RGB 平均；
 * 调整顺序会影响结果（先调亮度再调对比 ≠ 反过来）。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0
let program: WebGLProgram | null = null
let tex: WebGLTexture | null = null
let quad: WebGLBuffer | null = null
let uni: Record<string, WebGLUniformLocation | null> = {}

const brightness = ref(1)
const contrast = ref(1)
const saturation = ref(1)
const hue = ref(0)
const posterize = ref(0)
const vignette = ref(0)
const original = ref(false)

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
uniform sampler2D uTex;
uniform float uBright;
uniform float uContrast;
uniform float uSat;
uniform float uHue;
uniform float uPoster;
uniform float uVignette;
uniform vec2 uRes;
uniform vec2 uTexRes;

// Rec.709 亮度权重：人眼对绿色最敏感，直接 (r+g+b)/3 会让画面发灰
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hueRotate(vec3 c, float deg) {
  float a = radians(deg);
  float s = sin(a), co = cos(a);
  // YIQ 旋转矩阵的常用近似（保持亮度不变）
  mat3 m = mat3(
    0.299 + 0.701 * co + 0.168 * s, 0.587 - 0.587 * co + 0.330 * s, 0.114 - 0.114 * co - 0.497 * s,
    0.299 - 0.299 * co - 0.328 * s, 0.587 + 0.413 * co + 0.035 * s, 0.114 - 0.114 * co + 0.292 * s,
    0.299 - 0.300 * co + 1.250 * s, 0.587 - 0.588 * co - 1.050 * s, 0.114 + 0.886 * co - 0.203 * s
  );
  return clamp(m * c, 0.0, 1.0);
}

void main() {
  // 保持照片比例（cover）：屏幕比图更宽就裁上下，反之裁左右
  vec2 uv = vUv;
  float sa = uRes.x / max(uRes.y, 1.0);
  float ta = uTexRes.x / max(uTexRes.y, 1.0);
  if (sa > ta) uv.y = (uv.y - 0.5) * (ta / sa) + 0.5;
  else uv.x = (uv.x - 0.5) * (sa / ta) + 0.5;

  vec3 c = texture2D(uTex, uv).rgb;

  c *= uBright;                       // 亮度
  c = (c - 0.5) * uContrast + 0.5;    // 对比度（围绕 0.5 拉伸）
  c = mix(vec3(luma(c)), c, uSat);    // 饱和度：与亮度灰阶插值
  if (abs(uHue) > 0.001) c = hueRotate(c, uHue);

  if (uPoster > 0.0) {                // 色调分离：把 0~1 量化成 N 级
    float n = max(2.0, uPoster);
    c = floor(c * n + 0.5) / n;
  }

  if (uVignette > 0.0) {              // 暗角：按到中心的距离衰减
    vec2 d = vUv - 0.5;
    float v = 1.0 - uVignette * smoothstep(0.15, 0.72, length(d) * 1.4);
    c *= v;
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`

/** 程序生成一张"照片"：天空渐变 + 远山 + 太阳 + 前景草地，避免依赖外部图片 */
function makePhoto(): HTMLCanvasElement {
  const s = 512
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const g = cv.getContext('2d')!

  const sky = g.createLinearGradient(0, 0, 0, s * 0.72)
  sky.addColorStop(0, '#1b3a6b')
  sky.addColorStop(0.45, '#7aa7d8')
  sky.addColorStop(0.78, '#f3b06a')
  sky.addColorStop(1, '#f7d9a8')
  g.fillStyle = sky
  g.fillRect(0, 0, s, s)

  // 太阳
  const sun = g.createRadialGradient(s * 0.68, s * 0.44, 0, s * 0.68, s * 0.44, s * 0.22)
  sun.addColorStop(0, 'rgba(255,250,225,1)')
  sun.addColorStop(0.25, 'rgba(255,214,140,0.9)')
  sun.addColorStop(1, 'rgba(255,180,90,0)')
  g.fillStyle = sun
  g.beginPath()
  g.arc(s * 0.68, s * 0.44, s * 0.22, 0, Math.PI * 2)
  g.fill()

  // 远山（三层，越远越淡）
  const layers: Array<[number, string, number]> = [
    [0.62, '#5b6f8c', 0.55],
    [0.68, '#3f5470', 0.8],
    [0.74, '#27384f', 1],
  ]
  layers.forEach(([base, color, amp], li) => {
    g.fillStyle = color
    g.beginPath()
    g.moveTo(0, s)
    for (let x = 0; x <= s; x += 8) {
      const y =
        s * base -
        Math.sin((x / s) * Math.PI * (1.4 + li * 0.7) + li * 2.1) * s * 0.06 * amp -
        Math.sin((x / s) * Math.PI * (4.3 + li)) * s * 0.018
      g.lineTo(x, y)
    }
    g.lineTo(s, s)
    g.closePath()
    g.fill()
  })

  // 前景草地 + 亮斑（提供高频细节，滤镜效果才明显）
  g.fillStyle = '#16261c'
  g.beginPath()
  g.moveTo(0, s)
  for (let x = 0; x <= s; x += 6) {
    g.lineTo(x, s * 0.86 + Math.sin((x / s) * 22) * 6)
  }
  g.lineTo(s, s)
  g.fill()
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * s
    const y = s * 0.86 + Math.random() * s * 0.14
    g.fillStyle = `rgba(${120 + Math.random() * 90}, ${170 + Math.random() * 60}, ${70 + Math.random() * 60}, 0.5)`
    g.fillRect(x, y, 2, 2)
  }
  return cv
}

function upload(cv: HTMLCanvasElement) {
  const gl = ctx!.gl
  tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // canvas 的第 0 行是顶部，WebGL 纹理 v=0 在底部，不翻转会上下颠倒
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

function draw() {
  if (!ctx || !program) return
  const gl = ctx.gl
  gl.viewport(0, 0, ctx.canvas.width, ctx.canvas.height)
  gl.clearColor(0.04, 0.06, 0.09, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(program)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.uniform1i(uni.uTex, 0)
  gl.uniform1f(uni.uBright, original.value ? 1 : brightness.value)
  gl.uniform1f(uni.uContrast, original.value ? 1 : contrast.value)
  gl.uniform1f(uni.uSat, original.value ? 1 : saturation.value)
  gl.uniform1f(uni.uHue, original.value ? 0 : hue.value)
  gl.uniform1f(uni.uPoster, original.value ? 0 : posterize.value)
  gl.uniform1f(uni.uVignette, original.value ? 0 : vignette.value)
  gl.uniform2f(uni.uRes, ctx.canvas.width, ctx.canvas.height)
  gl.uniform2f(uni.uTexRes, 512, 512)

  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  const loc = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

onMounted(() => {
  if (!container.value) return
  ctx = setupGL(container.value)
  if (!ctx) return
  const gl = ctx.gl
  program = createProgram(gl, VS, FS)
  if (!program) return
  uni = {
    uTex: gl.getUniformLocation(program, 'uTex'),
    uBright: gl.getUniformLocation(program, 'uBright'),
    uContrast: gl.getUniformLocation(program, 'uContrast'),
    uSat: gl.getUniformLocation(program, 'uSat'),
    uHue: gl.getUniformLocation(program, 'uHue'),
    uPoster: gl.getUniformLocation(program, 'uPoster'),
    uVignette: gl.getUniformLocation(program, 'uVignette'),
    uRes: gl.getUniformLocation(program, 'uRes'),
    uTexRes: gl.getUniformLocation(program, 'uTexRes'),
  }

  quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  upload(makePhoto())
  draw()

  const onResize = () => {
    ctx!.resize()
    draw()
  }
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

watch([brightness, contrast, saturation, hue, posterize, vignette, original], draw)

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    if (program) gl.deleteProgram(program)
    if (tex) gl.deleteTexture(tex)
    if (quad) gl.deleteBuffer(quad)
  }
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">图像滤镜链 · 单趟片元着色器</div>
      <div class="ctrl">
        <span class="lab">亮度</span>
        <input v-model.number="brightness" type="range" min="0.2" max="2" step="0.02" />
        <b>{{ brightness.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">对比度</span>
        <input v-model.number="contrast" type="range" min="0.3" max="2.2" step="0.02" />
        <b>{{ contrast.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">饱和度</span>
        <input v-model.number="saturation" type="range" min="0" max="2.2" step="0.02" />
        <b>{{ saturation.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">色相</span>
        <input v-model.number="hue" type="range" min="-180" max="180" step="2" />
        <b>{{ hue }}<i>°</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">色调分离</span>
        <input v-model.number="posterize" type="range" min="0" max="12" step="1" />
        <b>{{ posterize === 0 ? '关' : posterize + ' 级' }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">暗角</span>
        <input v-model.number="vignette" type="range" min="0" max="1" step="0.02" />
        <b>{{ Math.round(vignette * 100) }}<i>%</i></b>
      </div>
      <button class="chip" :class="{ on: original }" @click="original = !original">
        {{ original ? '显示处理结果' : '对比原图' }}
      </button>
      <div class="tip">
        亮度用 Rec.709 权重（绿 0.715 / 红 0.213 / 蓝 0.072），直接 RGB 平均会发灰。
        饱和度是与灰阶做 mix，色相走 YIQ 旋转矩阵以保持亮度；色调分离就是量化到 N 级。
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
  flex: 0 0 50px;
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
</style>
