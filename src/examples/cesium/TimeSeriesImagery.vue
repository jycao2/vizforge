<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'
import { makeImageMaterial, makeRectanglePrimitive, makeTextureUploader } from './demMesh'

/* ============================================================
 * 时序影像产品 · 时间轴
 *
 * 遥感产品常见的交付形态：同一区域、多期影像、按时间轴浏览，
 * 配上指标曲线（建成区扩张 / 植被覆盖变化）和"基准期卷帘对比"。
 *
 * 影像是程序化合成的（离线可跑、真值已知）：
 *  - 先烘一遍静态场：建成区概率场（fBm - 距中心衰减）、植被场、河流距离场、地形晕渲
 *  - 每一期只是"阈值不同"：年份越晚阈值越低 → 建成区像细胞一样向外生长
 *  - 建成区面积 / 植被指数 / 水域面积逐期统计，画成指标曲线
 *  - 2013 年起多了一座水库（波段里出现新水面），考验观察力
 *
 * 卷帘对比在材质里做：同一材质两张纹理，按 st.x 与 uSplit 选边，
 * 分割线直接画在着色器里 —— 一层图元搞定，不用两个图层叠放。
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 117.24
const LAT = 39.12
const SPAN = 26000
const W = 512

/* ---------------- 时相 ---------------- */
const YEARS: number[] = []
for (let y = 2001; y <= 2025; y += 2) YEARS.push(y)
const frameIdx = ref(0)
const playing = ref(false)
const speed = ref(1.2) // 期/秒
const compare = ref(false)
const split = ref(0.5)

const currentYear = computed(() => YEARS[frameIdx.value] ?? YEARS[0])
const dateText = computed(() => `${currentYear.value}-06-22 L2A 产品`)

/* ---------------- 静态场 ---------------- */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const fade = (t: number) => t * t * (3 - 2 * t)
function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = fade(x - xi)
  const yf = fade(y - yi)
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf
}
function fbm(x: number, y: number, seed: number, oct = 5): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let fx = x
  let fy = y
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(fx, fy, seed + i * 131)
    norm += amp
    amp *= 0.5
    fx *= 2.03
    fy *= 2.03
  }
  return sum / norm
}

/** 城市生长中心（含一个后起的新区） */
const CENTERS: Array<[number, number, number]> = [
  [0.38, 0.42, 1.0], // 老城
  [0.66, 0.55, 0.72], // 副城
  [0.5, 0.3, 0.5], // 临空港（2015 年后加速）
]

/** 静态场各一份（512² Float32，共 5 张 ≈ 5MB，一次性代价） */
const urbanField = new Float32Array(W * W) // 建成区概率场（噪声 - 距离衰减）
const vegField = new Float32Array(W * W)
const shadeField = new Float32Array(W * W)
const riverV = (u: number) => 0.72 + 0.06 * Math.sin(u * Math.PI * 1.6 + 1.2) - u * 0.1

for (let py = 0; py < W; py++) {
  const v = py / (W - 1)
  for (let px = 0; px < W; px++) {
    const u = px / (W - 1)
    const k = py * W + px
    // 建成区概率：fBm 噪声 × 各中心的"势能"叠加
    let pot = 0
    for (const [cu, cv, w] of CENTERS) {
      const dx = (u - cu) * 1.15
      const dy = v - cv
      pot = Math.max(pot, w * Math.exp(-(dx * dx + dy * dy) / 0.028))
    }
    urbanField[k] = fbm(u * 7.3, v * 7.3, 991, 5) * 0.55 + pot * 0.85
    vegField[k] = fbm(u * 11.2, v * 11.2, 557, 4)
    shadeField[k] = 0.82 + 0.36 * (fbm(u * 5.1, v * 5.1, 313, 4) - 0.5)
  }
}

/* ---------------- 逐期渲染 ---------------- */
interface FrameStat {
  year: number
  urban: number // 建成区面积 km²
  ndvi: number // 植被指数 0..1
  water: number // 水域 km²
}
const frames: HTMLCanvasElement[] = []
const stats: FrameStat[] = []
const totalArea = (SPAN / 1000) ** 2
const PX_AREA = totalArea / (W * W)

function renderFrame(idx: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = W
  const g = canvas.getContext('2d')!
  const img = g.createImageData(W, W)
  const d = img.data
  const t = idx / (YEARS.length - 1)
  // 生长曲线：阈值随年份下降 → 建成区由内向外吞并
  const thr = 0.86 - t * 0.34
  const portBoost = YEARS[idx] >= 2015 ? 0.06 : 0

  let urbanPx = 0
  let waterPx = 0
  let vegSum = 0
  let vegN = 0

  for (let py = 0; py < W; py++) {
    const v = py / (W - 1)
    for (let px = 0; px < W; px++) {
      const u = px / (W - 1)
      const k = py * W + px
      const rd = Math.abs(v - riverV(u))
      const isRiver = rd < 0.006 + 0.004 * noise2(u * 40, 0, 7)
      // 2013 年起建成的水库
      const lakeDx = u - 0.74
      const lakeDy = (v - 0.34) * 1.6
      const isLake = YEARS[idx] >= 2013 && lakeDx * lakeDx + lakeDy * lakeDy < 0.0032

      let r: number
      let gg: number
      let b: number
      const urban = urbanField[k] + portBoost * (u > 0.44 && u < 0.58 ? 1 : 0) > thr

      if (isRiver || isLake) {
        const deep = isLake ? 0.8 : Math.min(rd / 0.008, 1)
        r = 26 + 24 * deep
        gg = 58 + 42 * deep
        b = 96 + 50 * deep
        waterPx++
      } else if (urban) {
        urbanPx++
        // 屋顶灰度：噪声决定厂房/楼房/低矮建筑
        const n = vegField[k]
        const l = 96 + n * 78
        r = l * 1.04
        gg = l * 1.0
        b = l * 0.98
      } else {
        // 非建成区：植被（NDVI 越低越黄）+ 农田条纹理
        const crop = noise2(u * 90, v * 90, 77) > 0.52 ? 1 : 0
        const ndvi = Math.min(1, Math.max(0, vegField[k] * 1.25 - 0.22 * t * (urbanField[k] * 2.2)))
        if (crop) {
          r = 150 - ndvi * 40
          gg = 150 - ndvi * 24
          b = 74 - ndvi * 22
        } else {
          r = 96 - ndvi * 46
          gg = 132 - ndvi * 42
          b = 74 - ndvi * 36
        }
        vegSum += ndvi
        vegN++
      }
      const shade = shadeField[k]
      const tt = (py * W + px) << 2
      d[tt] = r * shade
      d[tt + 1] = gg * shade
      d[tt + 2] = b * shade
      d[tt + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  stats[idx] = {
    year: YEARS[idx],
    urban: urbanPx * PX_AREA,
    ndvi: vegN ? vegSum / vegN : 0,
    water: waterPx * PX_AREA,
  }
  return canvas
}

for (let i = 0; i < YEARS.length; i++) frames.push(renderFrame(i))

/* ---------------- 指标曲线 ---------------- */
const chartRef = ref<HTMLCanvasElement>()

function drawChart() {
  const c = chartRef.value
  if (!c) return
  const g = c.getContext('2d')!
  const w = c.width
  const h = c.height
  g.clearRect(0, 0, w, h)
  g.strokeStyle = 'rgba(96,116,140,0.35)'
  g.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(w, y)
    g.stroke()
  }
  // 建成区面积曲线
  const maxU = Math.max(...stats.map((s) => s.urban)) * 1.1
  g.strokeStyle = '#f2a24b'
  g.lineWidth = 2
  g.beginPath()
  stats.forEach((s, i) => {
    const x = (i / (stats.length - 1)) * (w - 8) + 4
    const y = h - 6 - (s.urban / maxU) * (h - 14)
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  })
  g.stroke()
  // 当前帧标记
  const cx = (frameIdx.value / (stats.length - 1)) * (w - 8) + 4
  const cy = h - 6 - (stats[frameIdx.value].urban / maxU) * (h - 14)
  g.fillStyle = '#ffd479'
  g.beginPath()
  g.arc(cx, cy, 3.5, 0, Math.PI * 2)
  g.fill()
}

/* ---------------- 图元 ---------------- */
let prim: Cesium.Primitive | null = null
let mat: Cesium.Material | null = null
/** 当期影像的上传器（换帧时原子替换，避免闪烁） */
const uploader = makeTextureUploader()
/** 基准期用的上传器：让 image2 与 image 走完全相同的 ImageBitmap 路径。
 *  实测若两种来源不同（一个 canvas、一个 ImageBitmap），两半边的采样行为会不一致 ——
 *  直方图与「纯 2001」帧几乎完全相同，但逐像素相关系数接近 0。 */
const baseUploader = makeTextureUploader('image2')

const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.02, 34000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-88), roll: 0 },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(() => viewer, () => home)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const cur = computed(() => stats[frameIdx.value])

function applyFrame() {
  if (!mat) return
  uploader.upload(mat, frames[frameIdx.value])
  drawChart()
}

/* ---------------- 播放 ---------------- */
let raf = 0
let last = 0
let frameAcc = 0
function tick(now: number) {
  if (playing.value) {
    // 同 FloodAnalysis：帧号要按「未取整的累计值」推进，否则每帧只加 0.02 期，
    // Math.round 之后永远回到同一期，播放看起来完全没反应。
    if (!last) {
      last = now
      frameAcc = frameIdx.value
    }
    const dt = Math.min((now - last) / 1000, 0.2)
    last = now
    frameAcc += dt * speed.value
    if (frameAcc >= YEARS.length - 0.001) frameAcc = 0
    frameIdx.value = Math.floor(frameAcc)
  } else {
    last = 0
    frameAcc = frameIdx.value
  }
  raf = requestAnimationFrame(tick)
}

watch(frameIdx, applyFrame)
watch(split, (v) => {
  if (mat) mat.uniforms.uSplit = v
})
watch(compare, (on) => {
  if (mat) mat.uniforms.uCompare = on ? 1 : 0
})

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false
  scene.fog.enabled = false

  mat = new Cesium.Material({
    fabric: {
      uniforms: {
        image: frames[0],
        image2: frames[0],
        uSplit: split.value,
        uCompare: 0,
      },
      source: `
        uniform sampler2D image;
        uniform sampler2D image2;
        uniform float uSplit;
        uniform float uCompare;
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec2 st = materialInput.st;
          vec4 a = texture(image, st);
          vec4 b = texture(image2, st);
          // 左半边当期、右半边基准期（未开启对比时 mask=0，整张都是当期）
          vec4 c = mix(a, b, step(uSplit, st.x) * uCompare);
          // 卷帘分割线：只有对比时才叠白色，注意系数必须在 uCompare 上
          float line = (1.0 - smoothstep(0.0, 0.0022, abs(st.x - uSplit))) * uCompare;
          c.rgb = mix(c.rgb, vec3(1.0), line * 0.9);
          m.diffuse = c.rgb;
          m.alpha = c.a;
          return m;
        }`,
    },
    translucent: false,
    minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
  })
  prim = makeRectanglePrimitive(
    { lon0: LON - 0.13, lat0: LAT - 0.105, lon1: LON + 0.13, lat1: LAT + 0.105 } as never,
    mat,
    40,
  )
  scene.primitives.add(prim)
  // 两半都通过 ImageBitmap 上传，保证 sampling 行为完全一致
  uploader.upload(mat, frames[0])
  baseUploader.upload(mat, frames[0])

  drawChart()
  raf = requestAnimationFrame(tick)
  viewer.camera.setView(home)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  uploader.dispose()
  baseUploader.dispose()
  mat = null
  prim = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>

    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="title">时序影像产品 · 2001–2025</div>
      <div class="sub">多期影像 + 时间轴 + 指标曲线 + 基准期卷帘对比</div>

      <div class="datebar">
        <b class="year">{{ currentYear }}</b>
        <span class="dt">{{ dateText }}</span>
      </div>

      <div class="timeline">
        <input v-model.number="frameIdx" type="range" min="0" :max="YEARS.length - 1" step="1" />
        <div class="ticks">
          <span v-for="(y, i) in YEARS" :key="y" :class="{ on: i === frameIdx }">{{ y }}</span>
        </div>
      </div>

      <div class="row btns">
        <button class="chip primary" @click="playing = !playing">
          {{ playing ? '⏸ 暂停' : '▶ 播放' }}
        </button>
        <button class="chip" :class="{ on: compare }" @click="compare = !compare">对比 2001</button>
        <button class="chip" @click="frameIdx = Math.max(0, frameIdx - 1)">‹ 前一期</button>
        <button class="chip" @click="frameIdx = Math.min(YEARS.length - 1, frameIdx + 1)">后一期 ›</button>
      </div>

      <div v-if="compare" class="ctrl">
        <span class="lab">卷帘位置</span>
        <input v-model.number="split" type="range" min="0" max="1" step="0.01" />
        <b>{{ (split * 100).toFixed(0) }}<i>%</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">播放速度</span>
        <input v-model.number="speed" type="range" min="0.4" max="3" step="0.1" />
        <b>{{ speed.toFixed(1) }}<i>期/s</i></b>
      </div>

      <canvas ref="chartRef" width="300" height="70" class="chart"></canvas>

      <div class="stat">
        <div class="item"><span class="k">建成区</span><b>{{ cur.urban.toFixed(0) }}<i>km²</i></b></div>
        <div class="item"><span class="k">植被指数</span><b>{{ cur.ndvi.toFixed(2) }}</b></div>
        <div class="item"><span class="k">水域</span><b>{{ cur.water.toFixed(1) }}<i>km²</i></b></div>
      </div>

      <div class="tip">
        影像为程序化合成：先烘一遍<b>建成区概率场</b>（fBm 噪声 + 城市中心势能），
        每期只改一个生长阈值 —— 年份越晚阈值越低，建成区像细胞一样向外吞并。
        橙色曲线是逐期建成区面积。打开「对比 2001」拖动卷帘，
        左右两半分别是当期与基准期，20 余年的城市扩张一目了然；
        2013 年后东北角多出的水面是新建水库。
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.cesium-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 340px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(13, 19, 27, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.sub {
  margin-top: 3px;
  font-size: 11px;
  color: #7d8fa2;
  line-height: 1.5;
}
.datebar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 9px;
  padding: 6px 9px;
  border-radius: 7px;
  background: rgba(24, 34, 46, 0.85);
  border: 1px solid rgba(80, 100, 124, 0.35);
}
.datebar .year {
  font-size: 21px;
  font-weight: 700;
  color: #ffd479;
  font-family: ui-monospace, monospace;
}
.datebar .dt {
  font-size: 11px;
  color: #8fa0b3;
}
.timeline {
  margin-top: 10px;
}
.timeline input[type='range'] {
  width: 100%;
  height: 4px;
  appearance: none;
  background: linear-gradient(90deg, rgba(110, 179, 242, 0.55), rgba(96, 116, 140, 0.5));
  border-radius: 2px;
  outline: none;
}
.timeline input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffd479;
  border: 2px solid #0e141c;
  cursor: pointer;
}
.ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 9px;
  font-family: ui-monospace, monospace;
  color: #67788b;
}
.ticks span.on {
  color: #ffd479;
  font-weight: 700;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.chip {
  padding: 5px 8px;
  font-size: 11px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  cursor: pointer;
  transition: all 0.15s;
}
.chip:hover {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.chip.on {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.chip.primary {
  background: linear-gradient(180deg, rgba(40, 150, 96, 0.95), rgba(24, 104, 66, 0.95));
  border-color: rgba(90, 210, 150, 0.7);
  color: #eafff4;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
}
.ctrl .lab {
  color: #8fa0b3;
  flex: 0 0 52px;
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
  color: #ffd479;
  font-size: 11.5px;
}
.ctrl b i {
  font-size: 9.5px;
  font-style: normal;
  color: #7f90a3;
  margin-left: 1px;
}
.chart {
  display: block;
  width: 100%;
  height: 70px;
  margin-top: 10px;
  border-radius: 7px;
  background: rgba(20, 29, 40, 0.8);
  border: 1px solid rgba(80, 100, 124, 0.3);
}
.stat {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 10px;
}
.item {
  padding: 6px 8px;
  border-radius: 7px;
  background: rgba(28, 38, 50, 0.75);
  border: 1px solid rgba(80, 100, 124, 0.3);
}
.item .k {
  display: block;
  font-size: 10px;
  color: #7f90a3;
}
.item b {
  font-size: 13px;
  font-weight: 600;
  color: #e9f1fa;
  font-family: ui-monospace, monospace;
}
.item b i {
  font-size: 9.5px;
  font-style: normal;
  color: #7f90a3;
  margin-left: 2px;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
