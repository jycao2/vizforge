<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import ImageLayer from 'ol/layer/Image'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import ImageStatic from 'ol/source/ImageStatic'
import Feature from 'ol/Feature'
import LineString from 'ol/geom/LineString'
import Point from 'ol/geom/Point'
import Draw from 'ol/interaction/Draw'
import { Fill, Stroke, Circle as CircleStyle, Style, Text } from 'ol/style'
import { fromLonLat, toLonLat } from 'ol/proj'
import type { Coordinate } from 'ol/coordinate'
import type OlBase from 'ol/Map'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import { HYPSOMETRIC, contourLine, hillshade, makeDEM, sampleH, type DEM } from '@/examples/shared/terrain'

/* ============================================================
 * 地形剖面分析
 *  - DEM 烘成晕渲底图（ hillshade + 分层设色 + 等高线）用 ImageStatic 贴进 OL
 *  - 剖面：沿折线等距采样 320 个点 → 距离-高程曲线，累计爬升/下降逐点累加
 *  - 回看：鼠标在剖面图上横移，地图上的游标点会跟着走到对应位置
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlBase | null = null

const LON = 103.98
const LAT = 30.72
const SPAN = 9000
const dem: DEM = makeDEM({ lon: LON, lat: LAT, span: SPAN, n: 161, relief: 430, shape: 'mountain', seed: 8086 })

// ImageStatic 需要 [minX, minY, maxX, maxY]（西南、东北角）
const extent = fromLonLat([dem.lon0, dem.lat0]).concat(fromLonLat([dem.lon1, dem.lat1])) as [
  number,
  number,
  number,
  number,
]
const CENTER = fromLonLat([LON, LAT])
const HOME_ZOOM = 12.1

const { current: currentBasemap, create: createBase, apply: applyBasemap } = useOlBasemap('light')
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, HOME_ZOOM)

/* ---------------- 晕渲底图 ---------------- */
const TEX = 720
function bakeTerrainCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = TEX
  const g = canvas.getContext('2d')!
  const shade = hillshade(dem, 315, 42, 1.5)
  const img = g.createImageData(TEX, TEX)
  const d = img.data
  const rel = dem.max - dem.min || 1
  for (let py = 0; py < TEX; py++) {
    const v = py / (TEX - 1)
    for (let px = 0; px < TEX; px++) {
      const u = px / (TEX - 1)
      const h = sampleH(dem, u, v)
      const c = HYPSOMETRIC((h - dem.min) / rel)
      const gi = Math.min(Math.floor(u * (dem.n - 1)), dem.n - 1)
      const gj = Math.min(Math.floor(v * (dem.n - 1)), dem.n - 1)
      const s = 0.5 + 0.5 * shade[gj * dem.n + gi]
      const t = (py * TEX + px) << 2
      d[t] = c[0] * s
      d[t + 1] = c[1] * s
      d[t + 2] = c[2] * s
      d[t + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  // 等高线
  g.lineCap = 'round'
  for (let level = Math.ceil(dem.min / 50) * 50; level < dem.max; level += 50) {
    const idx = Math.round(level / 50) % 5 === 0
    const segs = contourLine(dem, level)
    g.strokeStyle = idx ? 'rgba(120,90,40,0.65)' : 'rgba(60,60,50,0.28)'
    g.lineWidth = idx ? 2 : 1
    g.beginPath()
    for (let i = 0; i < segs.length; i += 4) {
      g.moveTo(segs[i] * TEX, segs[i + 1] * TEX)
      g.lineTo(segs[i + 2] * TEX, segs[i + 3] * TEX)
    }
    g.stroke()
  }
  return canvas
}

/* ---------------- 剖面采样 ---------------- */
interface Sample {
  dist: number // 距起点（米，球面）
  h: number
  lon: number
  lat: number
}
const SAMPLE_N = 320
const samples = ref<Sample[]>([])
const lengthText = ref('—')
const profStat = ref({ max: 0, min: 0, climb: 0, drop: 0, maxSlope: 0 })

function sampleLine(coords3857: Coordinate[]): Sample[] {
  const out: Sample[] = []
  let dist = 0
  for (let i = 0; i < SAMPLE_N; i++) {
    const f = i / (SAMPLE_N - 1)
    const segF = f * (coords3857.length - 1)
    const si = Math.min(Math.floor(segF), coords3857.length - 2)
    const t = segF - si
    const x = coords3857[si][0] + (coords3857[si + 1][0] - coords3857[si][0]) * t
    const y = coords3857[si][1] + (coords3857[si + 1][1] - coords3857[si][1]) * t
    if (i > 0) {
      const dx = x - coords3857[si][0]
      const dy = y - coords3857[si][1]
      dist += Math.hypot(dx, dy) // 近似：投影平面长度（中纬度误差 <0.5%）
    }
    const [lon, lat] = toLonLat([x, y])
    const u = (lon - dem.lon0) / (dem.lon1 - dem.lon0)
    const v = (dem.lat1 - lat) / (dem.lat1 - dem.lat0)
    out.push({ dist, h: sampleH(dem, u, v), lon, lat })
  }
  return out
}

function computeStats() {
  const s = samples.value
  if (!s.length) return
  let climb = 0
  let drop = 0
  let maxSlope = 0
  for (let i = 1; i < s.length; i++) {
    const dh = s[i].h - s[i - 1].h
    if (dh > 0) climb += dh
    else drop += -dh
    const ds = s[i].dist - s[i - 1].dist
    if (ds > 0) maxSlope = Math.max(maxSlope, (Math.abs(dh) / ds) * 100)
  }
  profStat.value = {
    max: Math.max(...s.map((p) => p.h)),
    min: Math.min(...s.map((p) => p.h)),
    climb,
    drop,
    maxSlope,
  }
  lengthText.value = `${(s[s.length - 1].dist / 1000).toFixed(2)} km`
}

/* ---------------- 剖面图 ---------------- */
const chartRef = ref<HTMLCanvasElement>()
const hoverText = ref('鼠标移到剖面图上可在地图中定位')

function drawChart() {
  const c = chartRef.value
  if (!c) return
  const g = c.getContext('2d')!
  const w = c.width
  const h = c.height
  g.clearRect(0, 0, w, h)
  const s = samples.value
  if (s.length < 2) {
    g.fillStyle = 'rgba(140,160,180,0.7)'
    g.font = '12px sans-serif'
    g.fillText('先在地图上画一条剖面线（或点「示例线」）', 12, h / 2)
    return
  }
  const maxD = s[s.length - 1].dist
  const lo = profStat.value.min - 20
  const hi = profStat.value.max + 30
  const px = (d: number) => 4 + (d / maxD) * (w - 8)
  const py = (v: number) => h - 8 - ((v - lo) / (hi - lo)) * (h - 20)
  // 山体剖面填充
  g.beginPath()
  g.moveTo(px(0), py(s[0].h))
  for (const p of s) g.lineTo(px(p.dist), py(p.h))
  g.lineTo(px(maxD), h - 8)
  g.lineTo(px(0), h - 8)
  g.closePath()
  const grad = g.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, 'rgba(120,168,110,0.85)')
  grad.addColorStop(1, 'rgba(70,96,64,0.55)')
  g.fillStyle = grad
  g.fill()
  g.strokeStyle = '#d7e8c8'
  g.lineWidth = 1.5
  g.beginPath()
  s.forEach((p, i) => (i ? g.lineTo(px(p.dist), py(p.h)) : g.moveTo(px(p.dist), py(p.h))))
  g.stroke()
  // 起终点
  g.fillStyle = '#ffd479'
  g.font = '10px sans-serif'
  g.fillText('A', px(0) + 2, py(s[0].h) - 5)
  g.fillText('B', px(maxD) - 10, py(s[s.length - 1].h) - 5)
  hoverMarker(-1)
}

/** 鼠标在剖面图上 → 地图游标 */
function hoverMarker(idx: number) {
  const s = samples.value
  if (idx >= 0 && idx < s.length && cursorFeature) {
    cursorFeature.getGeometry()!.setCoordinates(fromLonLat([s[idx].lon, s[idx].lat]))
    cursorFeature.setStyle(cursorStyle(true))
    hoverText.value = `里程 ${(s[idx].dist / 1000).toFixed(2)} km · 高程 ${s[idx].h.toFixed(0)} m`
  } else if (cursorFeature) {
    cursorFeature.setStyle(cursorStyle(false))
    if (s.length > 1) hoverText.value = '鼠标移到剖面图上可在地图中定位'
  }
}

function onChartMove(e: MouseEvent) {
  const c = chartRef.value
  if (!c || samples.value.length < 2) return
  const rect = c.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * c.width
  const s = samples.value
  const maxD = s[s.length - 1].dist
  const f = Math.max(0, Math.min(1, (x - 4) / (c.width - 8)))
  hoverMarker(Math.round(f * (SAMPLE_N - 1)))
  void maxD
}

/* ---------------- 地图 ---------------- */
let imageLayer: ImageLayer<ImageStatic> | null = null
let lineLayer: VectorLayer<Feature> | null = null
let cursorFeature: Feature<Point> | null = null
let draw: Draw | null = null

const lineStyle = new Style({
  stroke: new Stroke({ color: '#ffdf6b', width: 3 }),
})
const cursorStyle = (show: boolean) =>
  new Style({
    image: show
      ? new CircleStyle({
          radius: 6,
          fill: new Fill({ color: '#ff5a4e' }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
        })
      : undefined,
  })

let drawLayer: VectorLayer<Feature> | null = null

function startDraw() {
  if (!map || !drawLayer) return
  if (draw) map.removeInteraction(draw)
  draw = new Draw({ type: 'LineString', source: drawLayer.getSource() ?? undefined })
  draw.on('drawend', (e) => {
    const geom = e.feature.getGeometry() as LineString
    applyLine(geom.getCoordinates())
  })
  map.addInteraction(draw)
}

function applyLine(coords: Coordinate[]) {
  if (coords.length < 2 || !lineLayer) return
  const src = lineLayer.getSource()!
  src.clear()
  const f = new Feature(new LineString(coords))
  f.setStyle(lineStyle)
  src.addFeature(f)
  const [lon0, lat0] = toLonLat(coords[0])
  const [lon1, lat1] = toLonLat(coords[coords.length - 1])
  const mkLabel = (txt: string, lon: number, lat: number) => {
    const f2 = new Feature(new Point(fromLonLat([lon, lat])))
    f2.setStyle(
      new Style({
        image: new CircleStyle({
          radius: 5,
          fill: new Fill({ color: '#ffdf6b' }),
          stroke: new Stroke({ color: '#223', width: 2 }),
        }),
        text: new Text({
          text: txt,
          offsetY: -14,
          font: '600 12px sans-serif',
          fill: new Fill({ color: '#fff' }),
          stroke: new Stroke({ color: '#001', width: 3 }),
        }),
      }),
    )
    src.addFeature(f2)
  }
  mkLabel('A', lon0, lat0)
  mkLabel('B', lon1, lat1)
  samples.value = sampleLine(coords)
  computeStats()
  drawChart()
}

function presetLine() {
  // 一条横穿主脊的示例线
  const [x0, y0] = fromLonLat([dem.lon0 + (dem.lon1 - dem.lon0) * 0.06, dem.lat0 + (dem.lat1 - dem.lat0) * 0.24])
  const [x1, y1] = fromLonLat([dem.lon1 - (dem.lon1 - dem.lon0) * 0.06, dem.lat1 - (dem.lat1 - dem.lat0) * 0.3])
  const [xm, ym] = fromLonLat([LON, LAT + 0.012])
  applyLine([[x0, y0], [xm, ym], [x1, y1]])
}

function clearLine() {
  samples.value = []
  lineLayer?.getSource()?.clear()
  drawLayer?.getSource()?.clear()
  drawChart()
}

onMounted(() => {
  map = new OlMap({
    target: container.value,
    layers: [createBase()],
    view: new View({ center: CENTER, zoom: HOME_ZOOM, maxZoom: 17 }),
  })

  imageLayer = new ImageLayer({
    source: new ImageStatic({
      url: bakeTerrainCanvas().toDataURL('image/png'),
      imageExtent: extent,
      projection: 'EPSG:3857',
    }),
    opacity: 0.96,
  })
  map.addLayer(imageLayer)

  lineLayer = new VectorLayer({ source: new VectorSource(), zIndex: 10 })
  drawLayer = new VectorLayer({
    source: new VectorSource(),
    style: new Style({
      stroke: new Stroke({ color: '#ffdf6b', width: 3, lineDash: [6, 5] }),
    }),
    zIndex: 11,
  })
  map.addLayer(lineLayer)
  map.addLayer(drawLayer)

  cursorFeature = new Feature(new Point(CENTER))
  cursorFeature.setStyle(cursorStyle(false))
  lineLayer.getSource()!.addFeature(cursorFeature)

  setTimeout(presetLine, 150)
})

watch(currentBasemap, applyBasemap)

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
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
      <div class="title">地形剖面分析</div>
      <div class="sub">晕渲 DEM 底图 + 沿线采样剖面 + 地图游标联动</div>

      <div class="row btns">
        <button class="chip primary" @click="startDraw">画剖面线</button>
        <button class="chip" @click="presetLine">示例线</button>
        <button class="chip" @click="clearLine">清除</button>
      </div>

      <canvas ref="chartRef" width="312" height="120" class="chart" @mousemove="onChartMove"></canvas>

      <div class="stat">
        <div class="item"><span class="k">线路长</span><b>{{ lengthText }}</b></div>
        <div class="item"><span class="k">最高</span><b>{{ profStat.max.toFixed(0) }}<i>m</i></b></div>
        <div class="item"><span class="k">最低</span><b>{{ profStat.min.toFixed(0) }}<i>m</i></b></div>
        <div class="item"><span class="k">累计爬升</span><b>{{ profStat.climb.toFixed(0) }}<i>m</i></b></div>
        <div class="item"><span class="k">累计下降</span><b>{{ profStat.drop.toFixed(0) }}<i>m</i></b></div>
        <div class="item"><span class="k">最大坡度</span><b>{{ profStat.maxSlope.toFixed(0) }}<i>%</i></b></div>
      </div>

      <div class="hint">{{ hoverText }}</div>

      <div class="tip">
        底图是程序化 DEM 烘的<b>晕渲图</b>（Horn 山体阴影 + 分层设色 + 50m 等高线），
        经 ImageStatic 按地理范围贴进地图。剖面沿折线等距采样 320 点，
        累计爬升/下降把每个相邻采样点的高差分正负累加 —— 骑行/徒步路线的"体力曲线"就是这么算的。
        鼠标在剖面上横移，红色游标会落到地图上对应位置。
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
.chip.primary {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.chart {
  display: block;
  width: 100%;
  height: 120px;
  margin-top: 10px;
  border-radius: 7px;
  background: rgba(20, 29, 40, 0.82);
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
.hint {
  margin-top: 8px;
  font-size: 11px;
  color: #9fb2c6;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
