<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import ImageLayer from 'ol/layer/Image'
import ImageCanvas from 'ol/source/ImageCanvas'
import Feature from 'ol/Feature'
import { LineString, Point } from 'ol/geom'
import { Fill, Style, Stroke, Text } from 'ol/style'
import { fromLonLat, toLonLat } from 'ol/proj'
import type { Coordinate } from 'ol/coordinate'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

/* ============================================================
 * 等值线分析（气温场 + Marching Squares）
 *  - 标量场：纬度主导 + 若干高斯热源/冷涡 + 低频扰动，程序化生成
 *  - 等值线：Marching Squares 逐格求交点，再按端点把线段缝合成折线
 *  - 渲染：色带底图用 ImageCanvas，等值线用 VectorLayer，标注沿走向排布
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()

const month = ref(7)
const showField = ref(true)
const showIso = ref(true)
const hover = ref<{ lon: number; lat: number; v: number } | null>(null)
const isoCount = ref(0)
const levelCount = ref(0)

const { current: currentBasemap, create: createBasemap, apply: applyBasemap } = useOlBasemap('dark')
const HOME = fromLonLat([111.5, 32.5])
const homeZoom = 4.6
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, HOME, homeZoom)

let map: OlMap | null = null
let rasterSrc: ImageCanvas | null = null
let rasterLayer: ImageLayer<ImageCanvas> | null = null
let isoLayer: VectorLayer<Feature> | null = null
let vectorSrc: VectorSource<Feature> | null = null

/* ---------------- 标量场 ---------------- */
const DATA = { lon0: 96, lon1: 128, lat0: 18, lat1: 46 }
const RASTER_EXTENT = [
  ...fromLonLat([DATA.lon0, DATA.lat0]),
  ...fromLonLat([DATA.lon1, DATA.lat1]),
] as [number, number, number, number]
const GW = 128
const GH = 112

interface Bump {
  lon: number
  lat: number
  r: number
  a: number
}

const BUMPS: Bump[] = [
  { lon: 113.2, lat: 30.4, r: 2.3, a: 5.4 }, // 江汉盆地
  { lon: 107.4, lat: 33.6, r: 2.6, a: -6.2 }, // 秦岭
  { lon: 118.6, lat: 31.8, r: 2.1, a: 2.8 }, // 长江下游
  { lon: 103.2, lat: 30.2, r: 2.9, a: -4.6 }, // 川西高原
  { lon: 121.5, lat: 39.2, r: 2.4, a: -2.2 }, // 渤海
  { lon: 110.5, lat: 40.4, r: 3.2, a: -3.4 }, // 内蒙
  { lon: 115.4, lat: 24.6, r: 2.2, a: 3.6 }, // 华南
]

/** 季节因子：0=隆冬，1=盛夏 */
function seasonK(m: number) {
  return 0.5 - 0.5 * Math.cos(((m - 1) / 12) * Math.PI * 2)
}

/** 气温场（°C） */
function field(lon: number, lat: number, m: number) {
  const s = seasonK(m)
  // 纬度主导：南北温差盛夏约 0.8°C/度，隆冬更陡
  let v = 30 - (lat - 22) * (0.75 + 0.55 * (1 - s)) + (s - 0.5) * 22
  for (const b of BUMPS) {
    const dx = lon - b.lon
    const dy = lat - b.lat
    v += b.a * Math.exp(-(dx * dx + dy * dy) / (2 * b.r * b.r))
  }
  v += 1.2 * Math.sin(lon * 1.05 + s * 3.1) * Math.cos(lat * 0.85)
  return v
}

const grid = new Float32Array(GW * GH)
let vMin = 0
let vMax = 0

function sampleGrid(m: number) {
  vMin = Infinity
  vMax = -Infinity
  for (let j = 0; j < GH; j++) {
    const lat = DATA.lat0 + ((DATA.lat1 - DATA.lat0) * j) / (GH - 1)
    for (let i = 0; i < GW; i++) {
      const lon = DATA.lon0 + ((DATA.lon1 - DATA.lon0) * i) / (GW - 1)
      const v = field(lon, lat, m)
      grid[j * GW + i] = v
      if (v < vMin) vMin = v
      if (v > vMax) vMax = v
    }
  }
}

/** 色带：冷 → 暖 */
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [42, 74, 148]],
  [0.18, [56, 138, 190]],
  [0.38, [96, 196, 176]],
  [0.55, [176, 212, 122]],
  [0.72, [242, 208, 84]],
  [0.86, [238, 140, 66]],
  [1.0, [206, 62, 48]],
]

function rampColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t))
  for (let k = 1; k < RAMP.length; k++) {
    if (x <= RAMP[k][0]) {
      const [t0, c0] = RAMP[k - 1]
      const [t1, c1] = RAMP[k]
      const f = (x - t0) / (t1 - t0)
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

function rampCss(t: number, alpha = 1) {
  const [r, g, b] = rampColor(t)
  return `rgba(${r},${g},${b},${alpha})`
}

/* ---------------- Marching Squares ---------------- */
type Pt = [number, number]

/** 单元格四角值（每次 extractContours 前写入，避免把 4 个值一路传参） */
let v0 = 0
let v1 = 0
let v2 = 0
let v3 = 0

/** 求边上的交点（0:底 1:右 2:顶 3:左） */
function edgePoint(
  edge: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  level: number,
): Pt {
  const lerp = (a: number, b: number) => (level - a) / (b - a || 1e-9)
  switch (edge) {
    case 0:
      return [x0 + dx * lerp(v0, v1), y0]
    case 1:
      return [x0 + dx, y0 + dy * lerp(v1, v2)]
    case 2:
      return [x0 + dx - dx * lerp(v2, v3), y0 + dy]
    default:
      return [x0, y0 + dy - dy * lerp(v3, v0)]
  }
}

const TABLE: number[][] = [
  [],
  [3, 0],
  [0, 1],
  [3, 1],
  [1, 2],
  [3, 2, 0, 1],
  [0, 2],
  [3, 2],
  [2, 3],
  [2, 0],
  [0, 3, 1, 2],
  [2, 1],
  [1, 3],
  [1, 0],
  [0, 3],
  [],
]

function stitch(segs: Array<[Pt, Pt]>): Pt[][] {
  const key = (p: Pt) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`
  const byPoint = new Map<string, number[]>()
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p)
      const arr = byPoint.get(k)
      if (arr) arr.push(i)
      else byPoint.set(k, [i])
    }
  })
  const used = new Uint8Array(segs.length)
  const lines: Pt[][] = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const line: Pt[] = [segs[i][0], segs[i][1]]
    for (let dir = 0; dir < 2; dir++) {
      for (;;) {
        const end = dir === 0 ? line[line.length - 1] : line[0]
        const cands = byPoint.get(key(end))
        if (!cands) break
        let next = -1
        for (const c of cands) {
          if (!used[c]) {
            next = c
            break
          }
        }
        if (next < 0) break
        used[next] = 1
        const seg = segs[next]
        const other = key(seg[0]) === key(end) ? seg[1] : seg[0]
        if (dir === 0) line.push(other)
        else line.unshift(other)
      }
    }
    if (line.length > 1) lines.push(line)
  }
  return lines
}

/** 提取某一层等值线（返回经纬度折线） */
function extractContours(level: number): Pt[][] {
  const segs: Array<[Pt, Pt]> = []
  const dx = (DATA.lon1 - DATA.lon0) / (GW - 1)
  const dy = (DATA.lat1 - DATA.lat0) / (GH - 1)
  for (let j = 0; j < GH - 1; j++) {
    const y0 = DATA.lat0 + dy * j
    for (let i = 0; i < GW - 1; i++) {
      const x0 = DATA.lon0 + dx * i
      v0 = grid[j * GW + i]
      v1 = grid[j * GW + i + 1]
      v2 = grid[(j + 1) * GW + i + 1]
      v3 = grid[(j + 1) * GW + i]
      let idx = 0
      if (v0 > level) idx |= 1
      if (v1 > level) idx |= 2
      if (v2 > level) idx |= 4
      if (v3 > level) idx |= 8
      const t = TABLE[idx]
      if (!t.length) continue
      for (let k = 0; k < t.length; k += 2) {
        segs.push([
          edgePoint(t[k], x0, y0, dx, dy, level),
          edgePoint(t[k + 1], x0, y0, dx, dy, level),
        ])
      }
    }
  }
  return stitch(segs)
}

/* ---------------- 图层 ---------------- */
const contourStyle = (level: number, t: number, major: boolean) =>
  new Style({
    stroke: new Stroke({
      color: rampCss(Math.min(1, t + 0.1), major ? 1 : 0.72),
      width: major ? 2 : 1,
    }),
  })

const labelStyle = (level: number, major: boolean) =>
  new Style({
    text: new Text({
      text: `${level}`,
      font: '600 12px ui-monospace, monospace',
      fill: new Fill({ color: major ? 'rgba(255,255,255,0.98)' : 'rgba(226,236,246,0.9)' }),
      stroke: new Stroke({ color: 'rgba(6,12,20,0.92)', width: 3.5 }),
      overflow: true,
    }),
  })

function rebuild() {
  if (!vectorSrc || !rasterSrc) return
  const m = month.value
  sampleGrid(m)
  const span = vMax - vMin

  vectorSrc.clear()
  const step = span > 40 ? 4 : span > 26 ? 2.5 : 2
  const start = Math.ceil(vMin / step) * step
  let total = 0
  let levels = 0
  for (let lv = start; lv <= vMax; lv += step) {
    levels++
    const major = Math.abs(lv % (step * 4)) < 1e-6
    const style = contourStyle(lv, (lv - vMin) / span, major)
    const lines = extractContours(lv)
    for (const line of lines) {
      const coords: Coordinate[] = line.map(([lon, lat]) => fromLonLat([lon, lat]))
      const f = new Feature({ geometry: new LineString(coords) })
      f.setStyle(style)
      vectorSrc.addFeature(f)
      total++

      // 每条折线在中点放一个正向标注，太短的闭环不放，免得糊成一团
      if (major && coords.length > 12) {
        const mid = coords[Math.floor(coords.length * 0.55)]
        const lf = new Feature({ geometry: new Point(mid) })
        lf.setStyle(labelStyle(lv, true))
        vectorSrc.addFeature(lf)
      }
    }
  }
  isoCount.value = total
  levelCount.value = levels
  rasterSrc.changed()
}

function onMove(coordinate: Coordinate) {
  const [lon, lat] = toLonLat(coordinate)
  hover.value = { lon, lat, v: field(lon, lat, month.value) }
}

watch(showField, (v) => rasterLayer?.setVisible(v))
watch(showIso, (v) => isoLayer?.setVisible(v))

const cursorText = computed(() =>
  hover.value
    ? `${hover.value.lon.toFixed(2)}°E  ${hover.value.lat.toFixed(2)}°N`
    : '移入地图查看读数',
)
const valueText = computed(() => (hover.value ? `${hover.value.v.toFixed(1)} °C` : '—'))

onMounted(() => {
  if (!container.value) return

  // 色带底图：按当前视口尺寸把格点场双线性放大后贴上去
  rasterSrc = new ImageCanvas({
    canvasFunction: (_extent, _res, _ratio, size) => {
      const small = document.createElement('canvas')
      small.width = GW
      small.height = GH
      const sg = small.getContext('2d')!
      const img = sg.createImageData(GW, GH)
      for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
          const v = grid[(GH - 1 - j) * GW + i]
          const [r, g, b] = rampColor((v - vMin) / (vMax - vMin || 1))
          const o = (j * GW + i) * 4
          img.data[o] = r
          img.data[o + 1] = g
          img.data[o + 2] = b
          img.data[o + 3] = 168
        }
      }
      sg.putImageData(img, 0, 0)

      const big = document.createElement('canvas')
      big.width = Math.max(1, Math.round(size[0]))
      big.height = Math.max(1, Math.round(size[1]))
      const bg = big.getContext('2d')!
      bg.imageSmoothingEnabled = true
      // 只在数据范围内铺色带，范围外留出底图，读图时不会误以为全球都有数据
      const [ex0, ey0, ex1, ey1] = _extent as [number, number, number, number]
      const sx = big.width / (ex1 - ex0)
      const sy = big.height / (ey1 - ey0)
      const x0 = (RASTER_EXTENT[0] - ex0) * sx
      const x1 = (RASTER_EXTENT[2] - ex0) * sx
      const yTop = (ey1 - RASTER_EXTENT[3]) * sy
      const yBottom = (ey1 - RASTER_EXTENT[1]) * sy
      bg.drawImage(small, x0, yTop, x1 - x0, yBottom - yTop)

      // 边缘羽化：栅格数据的范围边界如果是一条硬直边，看起来像贴了张贴纸
      const mask = document.createElement('canvas')
      mask.width = big.width
      mask.height = big.height
      const mg = mask.getContext('2d')!
      mg.filter = 'blur(9px)'
      mg.fillStyle = '#fff'
      mg.fillRect(x0 + 7, yTop + 7, x1 - x0 - 14, yBottom - yTop - 14)
      bg.globalCompositeOperation = 'destination-in'
      bg.drawImage(mask, 0, 0)
      bg.globalCompositeOperation = 'source-over'
      return big
    },
    interpolate: true,
    projection: 'EPSG:3857',
  })

  vectorSrc = new VectorSource<Feature>()
  const rl = new ImageLayer({ source: rasterSrc, opacity: 0.78 })
  const il = new VectorLayer({ source: vectorSrc, declutter: false })
  rasterLayer = rl
  isoLayer = il

  map = new OlMap({
    target: container.value,
    layers: [
      createBasemap(),
      rl,
      il,
    ],
    view: new View({ center: HOME, zoom: homeZoom, minZoom: 3, maxZoom: 9 }),
    controls: [],
  })
  applyBasemap(currentBasemap.value)

  map.on('pointermove', (e) => onMove(e.coordinate))
  sampleGrid(month.value)
  rebuild()
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
  rasterSrc = null
  vectorSrc = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>

    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="title">气温等值线分析</div>
      <div class="sub">
        {{ levelCount }} 条等值线 · {{ isoCount }} 段折线 · {{ GW }}×{{ GH }} 格点
      </div>

      <div class="ctrl">
        <span class="lab">月份</span>
        <input v-model.number="month" type="range" min="1" max="12" step="1" @change="rebuild" />
        <b>{{ month }} 月</b>
      </div>

      <div class="readout">
        <div class="row">
          <span class="k">光标</span>
          <b class="mono">{{ cursorText }}</b>
        </div>
        <div class="row">
          <span class="k">气温</span>
          <b class="mono big">{{ valueText }}</b>
        </div>
      </div>

      <label class="check">
        <input v-model="showField" type="checkbox" />
        <span>色带场</span>
      </label>
      <label class="check">
        <input v-model="showIso" type="checkbox" />
        <span>等值线</span>
      </label>

      <div class="legend">
        <span class="lg-title">°C</span>
        <i v-for="k in 24" :key="k" :style="{ background: rampCss((k - 1) / 23) }"></i>
      </div>
      <div class="legend-num">
        <span>{{ Math.round(vMin) }}</span>
        <span>{{ Math.round((vMin + vMax) / 2) }}</span>
        <span>{{ Math.round(vMax) }}</span>
      </div>

      <div class="tip">
        等值线用 Marching Squares 在格心求交点，再按端点把线段缝合成折线；色带按同一套格点场
        采样生成，所以线和色块天然对齐。
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
.ol-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 300px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(14, 20, 28, 0.88);
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
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 11px;
}
.ctrl .lab {
  flex: 0 0 26px;
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
  flex: 0 0 44px;
  text-align: right;
  color: #ffd479;
  font-size: 11.5px;
  font-family: ui-monospace, monospace;
}
.readout {
  margin-top: 9px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(28, 38, 50, 0.75);
  border: 1px solid rgba(80, 100, 124, 0.3);
}
.readout .row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.readout .row + .row {
  margin-top: 4px;
}
.readout .k {
  font-size: 10.5px;
  color: #7f90a3;
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  color: #dbe6f2;
}
.mono.big {
  font-size: 15px;
  color: #ffd479;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  font-size: 11.5px;
  color: #a9b8c8;
  cursor: pointer;
}
.legend {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 10px;
}
.legend .lg-title {
  font-size: 10px;
  color: #7f90a3;
  margin-right: 4px;
}
.legend i {
  flex: 1;
  height: 9px;
}
.legend i:first-of-type {
  border-radius: 3px 0 0 3px;
}
.legend i:last-of-type {
  border-radius: 0 3px 3px 0;
}
.legend-num {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 10px;
  color: #7f90a3;
  font-family: ui-monospace, monospace;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
