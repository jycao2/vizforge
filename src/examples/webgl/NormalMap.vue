<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createProgram, lookAt, multiply, perspective, setupGL, textureFromCanvas, type GLContext } from './gl'

/**
 * 法线贴图（切线空间）
 *
 * 几何只是一个平面，凹凸全部来自法线图：把 RGB 当成 xyz（0~1 映射到 -1~1），
 * 用切线空间基向量 TBN 转到世界空间，再参与光照。所以法线图整体偏蓝 ——
 * B 通道对应 z（表面朝外），平直处 z≈1，编码后就是 255。
 *
 * 高度图 → 法线图是离线（这里是运行时）用法线差分算出来的：
 *   n = normalize(-dh/dx * strength, -dh/dy * strength, 1)
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

const strength = ref(1.6)
const lightAz = ref(135)
const lightAlt = ref(26)
const enabled = ref(true)
const view = ref<'shade' | 'normal' | 'height'>('shade')

let prog: WebGLProgram | null = null
let quad: WebGLBuffer | null = null
let normalTex: WebGLTexture | null = null
let heightTex: WebGLTexture | null = null
let u: Record<string, WebGLUniformLocation | null> = {}

const VS = /* glsl */ `
attribute vec2 aPos;
uniform mat4 uMvp;
uniform float uRepeat;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = (aPos * 0.5 + 0.5) * uRepeat;
  vWorld = vec3(aPos.x * 4.0, 0.0, -aPos.y * 4.0);
  gl_Position = uMvp * vec4(aPos.x * 4.0, 0.0, -aPos.y * 4.0, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;
uniform sampler2D uNormal;
uniform sampler2D uHeight;
uniform float uStrength;
uniform vec3 uLight;      // 世界空间方向光
uniform float uEnabled;
uniform int uMode;        // 0 着色 / 1 法线图 / 2 高度图

void main() {
  vec3 nTex = texture2D(uNormal, vUv).rgb;
  float h = texture2D(uHeight, vUv).r;

  if (uMode == 1) { gl_FragColor = vec4(nTex, 1.0); return; }
  if (uMode == 2) { gl_FragColor = vec4(vec3(h), 1.0); return; }

  // 解码：0~1 → -1~1，xy 乘强度，z 保持 1 后归一化
  vec3 n = nTex * 2.0 - 1.0;
  n = normalize(vec3(n.xy * uStrength, n.z));

  // 平面几何：T = +X，B = -Z，N = +Y。顶点法线是常量，所以 TBN 是固定矩阵
  vec3 N = vec3(0.0, 1.0, 0.0);
  vec3 T = vec3(1.0, 0.0, 0.0);
  vec3 B = vec3(0.0, 0.0, -1.0);
  vec3 worldN = normalize(mix(N, normalize(T * n.x + B * n.y + N * n.z), uEnabled));

  vec3 L = normalize(uLight);
  vec3 V = normalize(vec3(0.0, 2.2, 4.0) - vWorld);
  vec3 H = normalize(L + V);
  float diff = max(dot(worldN, L), 0.0);
  float spec = pow(max(dot(worldN, H), 0.0), 24.0);

  // 砖缝里塞点脏色，凹凸感更明显
  vec3 brick = vec3(0.62, 0.33, 0.24);
  vec3 mortar = vec3(0.42, 0.41, 0.38);
  vec3 albedo = mix(mortar, brick, smoothstep(0.35, 0.55, h));
  vec3 c = albedo * (0.22 + 0.85 * diff) + vec3(spec * 0.35);
  gl_FragColor = vec4(c, 1.0);
}
`

/** 画高度图：砖块 + 缝隙 + 噪点（灰度） */
function makeHeight(w = 512): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = cv.height = w
  const g = cv.getContext('2d')!
  g.fillStyle = '#3a3a3a'
  g.fillRect(0, 0, w, w)

  const rows = 8
  const cols = 4
  const bh = w / rows
  const bw = w / cols
  for (let r = 0; r < rows; r++) {
    const shift = (r % 2) * (bw / 2)
    for (let c = -1; c <= cols; c++) {
      const x = c * bw + shift + 3
      const y = r * bh + 3
      const tone = 190 + Math.floor(Math.random() * 45)
      g.fillStyle = `rgb(${tone},${tone},${tone})`
      g.fillRect(x, y, bw - 6, bh - 6)
      // 砖面轻微起伏
      for (let i = 0; i < 40; i++) {
        const px = x + Math.random() * (bw - 6)
        const py = y + Math.random() * (bh - 6)
        const v = 170 + Math.floor(Math.random() * 60)
        g.fillStyle = `rgba(${v},${v},${v},0.35)`
        g.fillRect(px, py, 2, 2)
      }
    }
  }
  return cv
}

/** 高度图 → 法线图（中心差分，边缘环绕以支持平铺） */
function normalFromHeight(height: HTMLCanvasElement, k = 2.4): HTMLCanvasElement {
  const w = height.width
  const h = height.height
  const src = height.getContext('2d')!.getImageData(0, 0, w, h).data
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')!
  const img = octx.createImageData(w, h)
  const at = (x: number, y: number) => {
    const xi = ((x % w) + w) % w
    const yi = ((y % h) + h) % h
    return src[(yi * w + xi) * 4] / 255
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k
      const dy = (at(x, y + 1) - at(x, y - 1)) * k
      // 注意 canvas 的 y 向下，纹理 v 向上，所以 dy 反号
      let nx = -dx
      let ny = dy
      let nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      nz /= len
      const i = (y * w + x) * 4
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255)
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      img.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      img.data[i + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)
  return out
}

function draw() {
  if (!ctx || !prog) return
  const gl = ctx!.gl
  gl.viewport(0, 0, ctx!.canvas.width, ctx!.canvas.height)
  gl.clearColor(0.05, 0.06, 0.08, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((48 * Math.PI) / 180, aspect, 0.1, 100)
  const mv = lookAt([0, 2.7, 4.4], [0, 0.15, 0], [0, 1, 0])
  gl.useProgram(prog)
  gl.uniformMatrix4fv(u.uMvp, false, multiply(proj, mv))
  gl.uniform1f(u.uRepeat, 3)

  const az = (lightAz.value * Math.PI) / 180
  const alt = (lightAlt.value * Math.PI) / 180
  gl.uniform3f(
    u.uLight,
    Math.cos(alt) * Math.cos(az),
    Math.sin(alt),
    Math.cos(alt) * Math.sin(az),
  )
  gl.uniform1f(u.uStrength, strength.value)
  gl.uniform1f(u.uEnabled, enabled.value ? 1 : 0)
  gl.uniform1i(u.uMode, view.value === 'shade' ? 0 : view.value === 'normal' ? 1 : 2)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, normalTex)
  gl.uniform1i(u.uNormal, 0)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, heightTex)
  gl.uniform1i(u.uHeight, 1)

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
    uMvp: gl.getUniformLocation(prog, 'uMvp'),
    uRepeat: gl.getUniformLocation(prog, 'uRepeat'),
    uNormal: gl.getUniformLocation(prog, 'uNormal'),
    uHeight: gl.getUniformLocation(prog, 'uHeight'),
    uStrength: gl.getUniformLocation(prog, 'uStrength'),
    uLight: gl.getUniformLocation(prog, 'uLight'),
    uEnabled: gl.getUniformLocation(prog, 'uEnabled'),
    uMode: gl.getUniformLocation(prog, 'uMode'),
  }

  quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  const heightCanvas = makeHeight(512)
  const normalCanvas = normalFromHeight(heightCanvas)
  heightTex = textureFromCanvas(gl, heightCanvas, false)
  normalTex = textureFromCanvas(gl, normalCanvas, true)
  // 平铺：必须是 POT 纹理才能 REPEAT
  for (const t of [heightTex, normalTex]) {
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  }

  draw()
  const onResize = () => {
    ctx!.resize()
    draw()
  }
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

watch([strength, lightAz, lightAlt, enabled, view], draw)

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    if (prog) gl.deleteProgram(prog)
    if (quad) gl.deleteBuffer(quad)
    if (normalTex) gl.deleteTexture(normalTex)
    if (heightTex) gl.deleteTexture(heightTex)
  }
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">法线贴图 · 切线空间</div>
      <div class="sub">几何只是平面，凹凸全来自 RGB 法线</div>

      <div class="chips">
        <button class="chip" :class="{ on: view === 'shade' }" @click="view = 'shade'">着色</button>
        <button class="chip" :class="{ on: view === 'normal' }" @click="view = 'normal'">法线图</button>
        <button class="chip" :class="{ on: view === 'height' }" @click="view = 'height'">高度图</button>
      </div>

      <div class="ctrl">
        <span class="lab">法线强度</span>
        <input v-model.number="strength" type="range" min="0" max="3" step="0.05" />
        <b>{{ strength.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">光源方位</span>
        <input v-model.number="lightAz" type="range" min="0" max="360" step="2" />
        <b>{{ lightAz }}<i>°</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">光源高度</span>
        <input v-model.number="lightAlt" type="range" min="5" max="85" step="1" />
        <b>{{ lightAlt }}<i>°</i></b>
      </div>
      <button class="chip wide" :class="{ on: enabled }" @click="enabled = !enabled">
        {{ enabled ? '关闭法线贴图（用顶点法线）' : '开启法线贴图' }}
      </button>

      <div class="tip">
        法线图整体偏蓝是因为 B 通道存的是 z 分量：表面平直处 z≈1，编码后接近 255。
        解码成 <code>rgb*2-1</code> 后乘强度、再经 TBN 转到世界空间（平面几何 TBN 是常量）。
        强度归零就等于关掉法线贴图，只剩平面光照。
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
  background: #080a0e;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 318px;
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
}
.chips {
  display: flex;
  gap: 5px;
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
.chip.wide {
  width: 100%;
  margin-top: 10px;
  padding: 5px 0;
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
  flex: 0 0 46px;
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
.tip code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(111, 179, 242, 0.12);
  color: #9fc9f0;
  font-size: 10px;
}
</style>
