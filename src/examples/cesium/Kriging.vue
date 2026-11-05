<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import { useCesiumView, VIEWER_OPTIONS } from './useCesium'
import { DEFAULT_BASEMAP, applyCesiumBasemap } from './basemaps'
import { marchingSquares } from '../shared/terrain'

/* ============================================================
 * 克里金插值（Ordinary Kriging）
 *  参考 jiawanlong/Cesium-Examples 的克里金示例与 kriging.js 的做法，重写为：
 *   1. 55 个离散采样站（气温场）
 *   2. 球状变差函数 γ(h) = c0 + c1(1.5h/a − 0.5(h/a)³)
 *   3. 解对偶克里金方程组 [Γ 1; 1ᵀ 0]·[w; μ] = [γ₀; 1]
 *      —— 矩阵只与「采样点两两距离」有关，先做一次 LU 分解，之后每个网格点
 *      只做 O(n²) 前代回代，64² 网格也能瞬间算完（这是性能关键）
 *   4. Marching Squares 抽等值线，PolylineCollection 一次画完
 * ============================================================ */

const container = ref<HTMLDivElement>()
const viewerRef = shallowRef<Viewer | null>(null)
const DEFAULTS: { range: number; nugget: number; model: 'spherical' | 'exponential' } = {
  range: 3200, // 变差函数变程 a（米）
  nugget: 0.25, // 块金 c0
  model: 'spherical',
}
const range = ref(DEFAULTS.range)
const nugget = ref(DEFAULTS.nugget)
const model = ref<'spherical' | 'exponential'>(DEFAULTS.model)
const showContour = ref(true)
const showStations = ref(true)
const stats = ref('')

const BOX = { west: 120.045, south: 30.175, east: 120.155, north: 30.275 }
const CENTER = [(BOX.west + BOX.east) / 2, (BOX.south + BOX.north) / 2]
const N = 64 // 网格边长

function getViewer() {
  return viewerRef.value
}

const { reset } = useCesiumView(getViewer, () => ({
  destination: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1] - 0.05, 16000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-62), roll: 0 },
  focus: {
    center: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1], 0),
    radius: 6500,
    range: 15000,
  },
}))

/* ---------------- 数据 ---------------- */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20261105)

interface Station {
  lon: number
  lat: number
  v: number
}
// 「真实」场：两个热岛 + 一个冷谷，采样站是它的稀疏观测
function truth(lon: number, lat: number) {
  const g = (cx: number, cy: number, sx: number, sy: number, amp: number) =>
    amp * Math.exp(-(((lon - cx) / sx) ** 2) - ((lat - cy) / sy) ** 2)
  return (
    18 +
    g(120.075, 30.245, 0.028, 0.022, 9) +
    g(120.125, 30.205, 0.022, 0.02, 7) -
    g(120.1, 30.235, 0.018, 0.016, 5)
  )
}
const STATIONS: Station[] = Array.from({ length: 55 }, () => {
  const lon = BOX.west + rand() * (BOX.east - BOX.west)
  const lat = BOX.south + rand() * (BOX.north - BOX.south)
  return { lon, lat, v: truth(lon, lat) + (rand() - 0.5) * 0.9 }
})

/* ---------------- 克里金数学 ---------------- */
function variogram(h: number, a: number, c0: number) {
  const c1 = 1 - c0
  if (h <= 0) return 0
  if (model.value === 'spherical') {
    if (h >= a) return c0 + c1
    const r = h / a
    return c0 + c1 * (1.5 * r - 0.5 * r * r * r)
  }
  // 指数模型：理论上永远达不到基台，这里用 3a 截断
  return c0 + c1 * (1 - Math.exp(-(3 * h) / a))
}

/** 带部分主元的 LU 分解（只做一次） */
function luDecompose(A: number[][], n: number) {
  const lu = A.map((r) => r.slice())
  const perm = Array.from({ length: n }, (_, i) => i)
  for (let k = 0; k < n; k++) {
    let p = k
    let max = Math.abs(lu[k][k])
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(lu[i][k]) > max) {
        max = Math.abs(lu[i][k])
        p = i
      }
    }
    if (p !== k) {
      const t = lu[p]
      lu[p] = lu[k]
      lu[k] = t
      const tp = perm[p]
      perm[p] = perm[k]
      perm[k] = tp
    }
    const d = lu[k][k]
    if (Math.abs(d) < 1e-12) continue
    for (let i = k + 1; i < n; i++) {
      const f = lu[i][k] / d
      lu[i][k] = f
      for (let j = k + 1; j < n; j++) lu[i][j] -= f * lu[k][j]
    }
  }
  return { lu, perm }
}
function solveLU(lu: number[][], perm: number[], b: number[], n: number) {
  const y = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    let s = b[perm[i]]
    for (let j = 0; j < i; j++) s -= lu[i][j] * y[j]
    y[i] = s
  }
  const x = new Array<number>(n)
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]
    for (let j = i + 1; j < n; j++) s -= lu[i][j] * x[j]
    const d = lu[i][i]
    x[i] = Math.abs(d) < 1e-12 ? 0 : s / d
  }
  return x
}

/** 一次性 LU + 逐格点求解，返回 N×N 场（第 0 行 = 北边） */
function krigeField(): Float32Array {
  const n = STATIONS.length
  const m = n + 1
  const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0))
  // 距离用「米」，把经纬度差按纬度缩放
  const mx = 111320 * Math.cos((CENTER[1] * Math.PI) / 180)
  const my = 110540
  const dist = (a: Station, b: Station) =>
    Math.hypot((a.lon - b.lon) * mx, (a.lat - b.lat) * my)

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = variogram(dist(STATIONS[i], STATIONS[j]), range.value, nugget.value)
    A[i][n] = 1
    A[n][i] = 1
  }
  A[n][n] = 0
  const { lu, perm } = luDecompose(A, m)

  const field = new Float32Array(N * N)
  const b = new Array<number>(m).fill(0)
  const probe: Station = { lon: 0, lat: 0, v: 0 }
  for (let j = 0; j < N; j++) {
    // 第 0 行 = 北边
    probe.lat = BOX.north - ((BOX.north - BOX.south) * j) / (N - 1)
    for (let i = 0; i < N; i++) {
      probe.lon = BOX.west + ((BOX.east - BOX.west) * i) / (N - 1)
      for (let k = 0; k < n; k++) b[k] = variogram(dist(probe, STATIONS[k]), range.value, nugget.value)
      b[n] = 1

      const w = solveLU(lu, perm, b, m)
      let sum = 0
      for (let k = 0; k < n; k++) sum += w[k] * STATIONS[k].v
      field[j * N + i] = sum
    }
  }
  return field
}

/* ---------------- 渲染 ---------------- */
let heatEntity: Cesium.Entity | null = null
let contourColl: Cesium.PolylineCollection | null = null
let stationPoints: Cesium.PointPrimitiveCollection | null = null
let lastMs = 0

function colorFor(t: number): [number, number, number] {
  // 蓝 → 青 → 黄 → 橙 → 红
  const stops: Array<[number, [number, number, number]]> = [
    [0, [40, 92, 190]],
    [0.3, [40, 180, 200]],
    [0.55, [240, 220, 90]],
    [0.78, [245, 150, 60]],
    [1, [220, 60, 50]],
  ]
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]
    const [t1, c1] = stops[i + 1]
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0 || 1)
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ]
    }
  }
  return [220, 60, 50]
}

function drawHeat(field: Float32Array, min: number, max: number) {
  const size = 256
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    // 画布第 0 行对应北边，ImageMaterialProperty 会把图片顶部贴在北边
    const sy = (y / (size - 1)) * (N - 1)
    const y0 = Math.floor(sy)
    const y1 = Math.min(N - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < size; x++) {
      const sx = (x / (size - 1)) * (N - 1)
      const x0 = Math.floor(sx)
      const x1 = Math.min(N - 1, x0 + 1)
      const fx = sx - x0
      const v =
        field[y0 * N + x0] * (1 - fx) * (1 - fy) +
        field[y0 * N + x1] * fx * (1 - fy) +
        field[y1 * N + x0] * (1 - fx) * fy +
        field[y1 * N + x1] * fx * fy
      const t = Math.min(1, Math.max(0, (v - min) / (max - min || 1)))
      const [r, g, b] = colorFor(t)
      const k = (y * size + x) * 4
      img.data[k] = r
      img.data[k + 1] = g
      img.data[k + 2] = b
      // 低值区更透明，让底图透出来
      img.data[k + 3] = Math.round(70 + 165 * Math.pow(t, 0.65))
    }
  }
  ctx.putImageData(img, 0, 0)
  return cv.toDataURL('image/png')
}

function rebuild() {
  const viewer = viewerRef.value
  if (!viewer || viewer.isDestroyed()) return
  const t0 = performance.now()
  const field = krigeField()
  let min = Infinity
  let max = -Infinity
  for (const v of field) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const url = drawHeat(field, min, max)

  // 贴地图层
  const rect = Cesium.Rectangle.fromDegrees(BOX.west, BOX.south, BOX.east, BOX.north)
  if (!heatEntity) {
    heatEntity = viewer.entities.add({
      rectangle: {
        coordinates: rect,
        material: new Cesium.ImageMaterialProperty({ image: url, transparent: true }),
        height: 0,
      },
    })
  } else {
    const r = heatEntity.rectangle!
    r.material = new Cesium.ImageMaterialProperty({ image: url, transparent: true })
    r.coordinates = new Cesium.ConstantProperty(rect)
  }

  // 等值线
  if (contourColl) {
    viewer.scene.primitives.remove(contourColl)
    contourColl = null
  }
  if (showContour.value) {
    contourColl = viewer.scene.primitives.add(new Cesium.PolylineCollection())
    const levels = 8
    for (let l = 1; l <= levels; l++) {
      const level = min + ((max - min) * l) / (levels + 1)
      const segs = marchingSquares(field, N, level)
      const t = (level - min) / (max - min || 1)
      const [r, g, b] = colorFor(t)
      const color = new Cesium.Color(r / 255, g / 255, b / 255, 0.85)
      for (let s = 0; s < segs.length; s += 4) {
        const lon0 = BOX.west + ((BOX.east - BOX.west) * segs[s]) / (N - 1)
        const lat0 = BOX.north - ((BOX.north - BOX.south) * segs[s + 1]) / (N - 1)
        const lon1 = BOX.west + ((BOX.east - BOX.west) * segs[s + 2]) / (N - 1)
        const lat1 = BOX.north - ((BOX.north - BOX.south) * segs[s + 3]) / (N - 1)
        contourColl.add({
          positions: Cesium.Cartesian3.fromDegreesArray([lon0, lat0, lon1, lat1]),
          width: level === Math.round(level) ? 2.4 : 1.8,
          // Material 不能跨线段共享：PolylineCollection.destroy() 会逐线段销毁材质，
          // 同一实例被销毁两次直接抛「This object was destroyed」，每次调参都在报错
          material: Cesium.Material.fromType('Color', { color }),
        })
      }
    }
  }

  // 采样站
  if (stationPoints) {
    viewer.scene.primitives.remove(stationPoints)
    stationPoints = null
  }
  if (showStations.value) {
    stationPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection())
    for (const s of STATIONS) {
      const t = Math.min(1, Math.max(0, (s.v - min) / (max - min || 1)))
      const [r, g, b] = colorFor(t)
      stationPoints.add({
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 30),
        pixelSize: 8,
        color: new Cesium.Color(r / 255, g / 255, b / 255, 1),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      })
    }
  }

  lastMs = performance.now() - t0
  stats.value = `场值 ${min.toFixed(1)} ~ ${max.toFixed(1)} ℃ · ${STATIONS.length} 站 · 计算 ${lastMs.toFixed(0)} ms`
}

onMounted(() => {
  const el = container.value
  if (!el) return
  const viewer = new Cesium.Viewer(el, { ...VIEWER_OPTIONS })
  viewerRef.value = viewer
  applyCesiumBasemap(viewer, DEFAULT_BASEMAP, null)
  viewer.scene.globe.depthTestAgainstTerrain = false

  // 边框：区域范围
  viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        BOX.west, BOX.south, BOX.east, BOX.south, BOX.east, BOX.north, BOX.west, BOX.north, BOX.west, BOX.south,
      ]),
      width: 2,
      material: Cesium.Color.fromCssColorString('#6ee7ff').withAlpha(0.75),
    },
  })

  // 首帧算一次
  requestAnimationFrame(() => rebuild())
})

onBeforeUnmount(() => {
  const v = viewerRef.value
  if (v && !v.isDestroyed()) v.destroy()
  viewerRef.value = null
})

function applyParams() {
  rebuild()
}

/** 复位要连参数一起还原：只飞相机的话，调过滑杆的用户点下去画面纹丝不动，像按钮坏了 */
function resetAll() {
  model.value = DEFAULTS.model
  range.value = DEFAULTS.range
  nugget.value = DEFAULTS.nugget
  showContour.value = true
  showStations.value = true
  applyParams()
  reset()
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="cesium-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">模型</span>
        <button
          class="btn"
          :class="{ active: model === 'spherical' }"
          @click="(model = 'spherical'), applyParams()"
        >
          球状
        </button>
        <button
          class="btn"
          :class="{ active: model === 'exponential' }"
          @click="(model = 'exponential'), applyParams()"
        >
          指数
        </button>
      </div>
      <div class="row">
        <span class="label">变程 a</span>
        <input
          class="range"
          type="range"
          min="800"
          max="7000"
          step="100"
          :value="range"
          @input="range = Number(($event.target as HTMLInputElement).value)"
          @change="applyParams()"
        />
        <span class="val">{{ (range / 1000).toFixed(1) }}km</span>
      </div>
      <div class="row">
        <span class="label">块金 c₀</span>
        <input
          class="range"
          type="range"
          min="0"
          max="0.8"
          step="0.02"
          :value="nugget"
          @input="nugget = Number(($event.target as HTMLInputElement).value)"
          @change="applyParams()"
        />
        <span class="val">{{ nugget.toFixed(2) }}</span>
      </div>
      <div class="row">
        <button class="btn" :class="{ active: showContour }" @click="(showContour = !showContour), applyParams()">
          等值线
        </button>
        <button class="btn" :class="{ active: showStations }" @click="(showStations = !showStations), applyParams()">
          采样站
        </button>
        <button class="btn" @click="resetAll()">复位</button>
      </div>
      <div class="meta">{{ stats }}</div>
      <div class="tip">
        普通克里金：变差函数描述空间相关性，解对偶方程组求权重。矩阵只与站点两两距离有关，
        先 LU 分解一次，64×64 网格逐点回代即可（这也是它能实时调参的原因）。
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
.cesium-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 320px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 46px;
  text-align: right;
}
.meta {
  font-size: 11.5px;
  color: #7ee787;
  margin: 2px 0 4px;
}
.tip {
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
.btn {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #9fd0ff;
  cursor: pointer;
}
.btn.active {
  background: #1f5c9e;
  color: #fff;
  border-color: #4f9dff;
}
</style>
