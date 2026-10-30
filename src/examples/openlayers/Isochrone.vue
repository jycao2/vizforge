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
import { Fill, Stroke, Circle as CircleStyle, Style, Text } from 'ol/style'
import { fromLonLat, toLonLat } from 'ol/proj'
import MultiLineString from 'ol/geom/MultiLineString'
import type { Coordinate } from 'ol/coordinate'
import type OlBase from 'ol/Map'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import { marchingSquares } from '@/examples/shared/terrain'

/* ============================================================
 * 路网等时圈（Isochrone）
 *
 * 与"缓冲区"不同，等时圈沿**路网**扩展 —— 过了河要走桥，翻不了山。
 *  1) 合成路网：网格主次干道 + 二环快速路，每条边带通行速度
 *  2) Dijkstra 以"时间 = 长度 / 速度"为代价跑单源最短路 → 每个路口的到达时间
 *  3) 路口时间场插值到细网格（IDW，k=6）→ Marching Squares 提 5/10/15/20 分钟等时线
 *  4) 时间场着色成底图 + 等时线矢量叠加，POI 标注"步行/车程可达"
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlBase | null = null

const LON = 121.48
const LAT = 31.22
const GRID = 15 // 路网 15×15 个路口
const STEP = 900 // 路口间距（米）
const NCELL = 150 // 插值网格分辨率

const CENTER = fromLonLat([LON, LAT])
const HOME_ZOOM = 11.9

const { current: currentBasemap, create: createBase, apply: applyBasemap } = useOlBasemap('light')
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, HOME_ZOOM)

/* ---------------- 路网 ---------------- */
type RoadClass = 'fast' | 'main' | 'sub'
const SPEED: Record<RoadClass, number> = { fast: 38, main: 26, sub: 14 } // km/h（高峰期）
interface Node {
  lon: number
  lat: number
  x: number // 局部米
  y: number
}
interface Edge {
  a: number
  b: number
  cls: RoadClass
}
const nodes: Node[] = []
const edges: Edge[] = []

function buildNetwork() {
  const mPerLon = 111320 * Math.cos((LAT * Math.PI) / 180)
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = (i - (GRID - 1) / 2) * STEP
      const y = ((GRID - 1) / 2 - j) * STEP
      nodes.push({ x, y, lon: LON + x / mPerLon, lat: LAT + y / 110540 })
    }
  }
  const idx = (i: number, j: number) => j * GRID + i
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      if (i < GRID - 1) {
        const ring = Math.max(Math.abs(i - 7), Math.abs(j - 7)) === 4 // 二环
        edges.push({ a: idx(i, j), b: idx(i + 1, j), cls: ring ? 'fast' : j % 4 === 1 ? 'main' : 'sub' })
      }
      if (j < GRID - 1) {
        const ring = Math.max(Math.abs(i - 7), Math.abs(j - 7)) === 4
        edges.push({ a: idx(i, j), b: idx(i, j + 1), cls: ring ? 'fast' : i % 5 === 2 ? 'main' : 'sub' })
      }
    }
  }
}
buildNetwork()

/** POI */
interface Poi {
  name: string
  kind: string
  i: number
  j: number
}
const POIS: Poi[] = [
  { name: '人民广场', kind: '枢纽', i: 7, j: 7 },
  { name: '儿童医院', kind: '医院', i: 4, j: 5 },
  { name: '科技园', kind: '就业', i: 11, j: 9 },
  { name: '会展中心', kind: '场馆', i: 10, j: 4 },
]

/* ---------------- Dijkstra ---------------- */
const src = ref({ i: 7, j: 7 }) // 出发点（路网索引）
const travelTime = new Float32Array(GRID * GRID) // 每个路口的到达时间（分钟）

function dijkstra() {
  const n = GRID * GRID
  const s = src.value.j * GRID + src.value.i
  const INF = 1e9
  const dist = new Float64Array(n).fill(INF)
  dist[s] = 0
  const done = new Uint8Array(n)
  // 简单二叉堆
  const heap: Array<[number, number]> = [[0, s]]
  const push = (d: number, v: number) => {
    heap.push([d, v])
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  // 邻接表
  const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => [])
  for (const e of edges) {
    const a = nodes[e.a]
    const b = nodes[e.b]
    const len = Math.hypot(a.x - b.x, a.y - b.y)
    const t = (len / 1000 / SPEED[e.cls]) * 60
    adj[e.a].push([e.b, t])
    adj[e.b].push([e.a, t])
  }
  while (heap.length) {
    const [d, v] = pop()
    if (done[v]) continue
    done[v] = 1
    for (const [w, t] of adj[v]) {
      if (d + t < dist[w]) {
        dist[w] = d + t
        push(dist[w], w)
      }
    }
  }
  for (let k = 0; k < n; k++) travelTime[k] = dist[k] >= INF ? 120 : dist[k]
}

/* ---------------- 时间场插值 + 等时线 ---------------- */
/** 插值网格：把路口时间场 IDW 到 NCELL×NCELL（局部米坐标） */
const fieldTime = new Float32Array(NCELL * NCELL)
const span = STEP * (GRID - 1)

function interpolateField() {
  // 每个插值点找最近的 6 个路口（网格规则，直接用索引邻域）
  for (let j = 0; j < NCELL; j++) {
    const y = span / 2 - (j / (NCELL - 1)) * span
    const gj = ((span / 2 - y) / span) * (GRID - 1)
    for (let i = 0; i < NCELL; i++) {
      const x = (i / (NCELL - 1)) * span - span / 2
      const gi = ((x + span / 2) / span) * (GRID - 1)
      let sw = 0
      let acc = 0
      const i0 = Math.max(0, Math.floor(gi) - 2)
      const j0 = Math.max(0, Math.floor(gj) - 2)
      for (let dj = 0; dj < 5; dj++) {
        for (let di = 0; di < 5; di++) {
          const ii = i0 + di
          const jj = j0 + dj
          if (ii >= GRID || jj >= GRID) continue
          const nd = nodes[jj * GRID + ii]
          const d2 = (nd.x - x) ** 2 + (nd.y - y) ** 2
          const w = 1 / (d2 + 1e4)
          sw += w
          acc += w * travelTime[jj * GRID + ii]
        }
      }
      fieldTime[j * NCELL + i] = acc / sw
    }
  }
}

/* ---------------- 渲染 ---------------- */
const TEX = 720
function bakeTimeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = TEX
  const g = canvas.getContext('2d')!
  const img = g.createImageData(TEX, TEX)
  const d = img.data
  // 时间 → 颜色：近处亮黄绿，远处渐紫
  const stops: Array<[number, number[]]> = [
    [0, [255, 226, 110]],
    [6, [250, 170, 80]],
    [12, [228, 100, 86]],
    [20, [168, 74, 122]],
    [30, [96, 62, 118]],
    [45, [40, 36, 72]],
  ]
  const ramp = (t: number) => {
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i]
      const [t1, c1] = stops[i + 1]
      if (t <= t1) {
        const k = (t - t0) / (t1 - t0)
        return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
      }
    }
    return stops[stops.length - 1][1]
  }
  for (let py = 0; py < TEX; py++) {
    const fj = Math.round((py / (TEX - 1)) * (NCELL - 1))
    for (let px = 0; px < TEX; px++) {
      const fi = Math.round((px / (TEX - 1)) * (NCELL - 1))
      const t = fieldTime[fj * NCELL + fi]
      const c = ramp(t)
      const k = (py * TEX + px) << 2
      d[k] = c[0]
      d[k + 1] = c[1]
      d[k + 2] = c[2]
      d[k + 3] = 200
    }
  }
  g.putImageData(img, 0, 0)
  return canvas
}

const ISO_LEVELS = [5, 10, 15, 20, 30, 45]
const ISO_COLORS = ['#f6e05e', '#a3d977', '#5cbfa8', '#4c86c8', '#6e6ab8', '#443c78']

let imageLayer: ImageLayer<ImageStatic> | null = null
let isoLayer: VectorLayer<Feature> | null = null
let roadLayer: VectorLayer<Feature> | null = null
let poiLayer: VectorLayer<Feature> | null = null
let srcLayer: VectorLayer<Feature> | null = null

/** 局部米 → 3857 坐标 */
const toMap = (x: number, y: number): Coordinate => fromLonLat([LON + x / (111320 * Math.cos((LAT * Math.PI) / 180)), LAT + y / 110540])

function extentOf(): [number, number, number, number] {
  // [minX, minY, maxX, maxY]（西南、东北角）
  const sw = toMap(-span / 2, -span / 2)
  const ne = toMap(span / 2, span / 2)
  return [sw[0], sw[1], ne[0], ne[1]]
}
const EXTENT = extentOf()

function drawIso() {
  const srcV = isoLayer?.getSource()
  if (!srcV) return
  srcV.clear()
  ISO_LEVELS.forEach((lv, li) => {
    const segs = marchingSquares(fieldTime, NCELL, lv)
    const lines: Coordinate[][] = []
    for (let k = 0; k < segs.length; k += 4) {
      const x1 = (segs[k] / (NCELL - 1)) * span - span / 2
      const y1 = span / 2 - (segs[k + 1] / (NCELL - 1)) * span
      const x2 = (segs[k + 2] / (NCELL - 1)) * span - span / 2
      const y2 = span / 2 - (segs[k + 3] / (NCELL - 1)) * span
      lines.push([toMap(x1, y1), toMap(x2, y2)])
    }
    const f = new Feature(new MultiLineString(lines))
    f.setStyle(
      new Style({
        stroke: new Stroke({
          color: ISO_COLORS[li],
          width: li < 2 ? 2.5 : 1.6,
          lineDash: li < 2 ? undefined : [7, 5],
        }),
      }),
    )
    srcV.addFeature(f)
  })
}

function drawRoads() {
  const srcV = roadLayer?.getSource()
  if (!srcV) return
  srcV.clear()
  for (const e of edges) {
    const a = nodes[e.a]
    const b = nodes[e.b]
    const f = new Feature(new LineString([toMap(a.x, a.y), toMap(b.x, b.y)]))
    const w = e.cls === 'fast' ? 4.5 : e.cls === 'main' ? 3 : 1.8
    const c = e.cls === 'fast' ? '#ff8a4c' : e.cls === 'main' ? '#ffd166' : 'rgba(220,228,236,0.55)'
    f.setStyle(new Style({ stroke: new Stroke({ color: c, width: w }) }))
    f.set('cls', e.cls)
    srcV.addFeature(f)
  }
}

function drawPois() {
  const srcV = poiLayer?.getSource()
  if (!srcV) return
  srcV.clear()
  for (const p of POIS) {
    const nd = nodes[p.j * GRID + p.i]
    const t = travelTime[p.j * GRID + p.i]
    const f = new Feature(new Point(toMap(nd.x, nd.y)))
    f.set('name', p.name)
    f.set('min', Math.round(t))
    f.setStyle(
      new Style({
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: t <= 15 ? '#7ee08a' : t <= 30 ? '#ffd166' : '#ff7b6b' }),
          stroke: new Stroke({ color: '#182028', width: 2 }),
        }),
        text: new Text({
          text: `${p.name} ${Math.round(t)}min`,
          offsetY: -15,
          font: '600 11px sans-serif',
          fill: new Fill({ color: '#eef4fa' }),
          stroke: new Stroke({ color: '#0c1218', width: 3 }),
        }),
      }),
    )
    srcV.addFeature(f)
  }
}

function drawSource() {
  const srcV = srcLayer?.getSource()
  if (!srcV) return
  srcV.clear()
  const nd = nodes[src.value.j * GRID + src.value.i]
  const f = new Feature(new Point(toMap(nd.x, nd.y)))
  f.setStyle(
    new Style({
      image: new CircleStyle({
        radius: 9,
        fill: new Fill({ color: '#38c6ff' }),
        stroke: new Stroke({ color: '#fff', width: 3 }),
      }),
      text: new Text({
        text: '出发',
        offsetY: 20,
        font: '600 12px sans-serif',
        fill: new Fill({ color: '#fff' }),
        stroke: new Stroke({ color: '#0c1218', width: 3 }),
      }),
    }),
  )
  srcV.addFeature(f)
}

const stat = ref({ r10: 0, r20: 0, avg: 0 })
function computeStats() {
  let a10 = 0
  let a20 = 0
  let sum = 0
  const cellA = (span / NCELL) ** 2
  for (let k = 0; k < fieldTime.length; k++) {
    const t = fieldTime[k]
    sum += t
    if (t <= 10) a10 += cellA
    if (t <= 20) a20 += cellA
  }
  stat.value = {
    r10: a10 / 1e6,
    r20: a20 / 1e6,
    avg: sum / fieldTime.length,
  }
}

function refresh() {
  dijkstra()
  interpolateField()
  computeStats()
  drawIso()
  drawPois()
  drawSource()
  if (map && imageLayer) {
    map.removeLayer(imageLayer)
    imageLayer = new ImageLayer({
      source: new ImageStatic({
        url: bakeTimeCanvas().toDataURL('image/png'),
        imageExtent: EXTENT,
        projection: 'EPSG:3857',
      }),
      zIndex: 1,
    })
    map.getLayers().insertAt(1, imageLayer)
  }
}

/* ---------------- 交互：点击设置出发点（吸附最近路口） ---------------- */
function onClick(e: { coordinate: Coordinate }) {
  const [lon, lat] = toLonLat(e.coordinate)
  let best = src.value
  let bestD = Infinity
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const nd = nodes[j * GRID + i]
      const d = (nd.lon - lon) ** 2 + (nd.lat - lat) ** 2
      if (d < bestD) {
        bestD = d
        best = { i, j }
      }
    }
  }
  src.value = best
}

onMounted(() => {
  map = new OlMap({
    target: container.value,
    layers: [createBase()],
    view: new View({ center: CENTER, zoom: HOME_ZOOM, maxZoom: 17 }),
  })
  imageLayer = new ImageLayer({
    source: new ImageStatic({
      url: bakeTimeCanvas().toDataURL('image/png'),
      imageExtent: EXTENT,
      projection: 'EPSG:3857',
    }),
    zIndex: 1,
  })
  map.addLayer(imageLayer)
  isoLayer = new VectorLayer({ source: new VectorSource(), zIndex: 5 })
  roadLayer = new VectorLayer({ source: new VectorSource(), zIndex: 6 })
  poiLayer = new VectorLayer({ source: new VectorSource(), zIndex: 8 })
  srcLayer = new VectorLayer({ source: new VectorSource(), zIndex: 9 })
  map.addLayer(isoLayer)
  map.addLayer(roadLayer)
  map.addLayer(poiLayer)
  map.addLayer(srcLayer)

  refresh()
  drawRoads()

  map.on('singleclick', (e) => onClick({ coordinate: e.coordinate }))
})

watch(src, refresh)
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
      <div class="title">路网等时圈</div>
      <div class="sub">Dijkstra 时间代价 → 时间场插值 → 等时线，点击地图换出发点</div>

      <div class="legend">
        <span v-for="(lv, i) in ISO_LEVELS" :key="lv" class="lg">
          <i :style="{ background: ISO_COLORS[i] }"></i>{{ lv }}min
        </span>
      </div>

      <div class="stat">
        <div class="item"><span class="k">10min 可达</span><b>{{ stat.r10.toFixed(1) }}<i>km²</i></b></div>
        <div class="item"><span class="k">20min 可达</span><b>{{ stat.r20.toFixed(1) }}<i>km²</i></b></div>
        <div class="item"><span class="k">平均通勤</span><b>{{ stat.avg.toFixed(0) }}<i>min</i></b></div>
      </div>

      <div class="hint">出发路口：第 {{ src.i + 1 }} 列 · 第 {{ src.j + 1 }} 行（点击地图任意处吸附最近路口）</div>

      <div class="tip">
        等时圈 ≠ 缓冲区：它沿<b>路网</b>扩张。每条边的时间代价 = 长度 ÷ 速度（快速路 64 /
        主干道 42 / 支路 24 km/h），Dijkstra 用二叉堆跑出全部路口的到达时间，
        再把"路口时间场"用 IDW 插到细网格上，Marching Squares 提取 5/10/15/20 分钟等时线。
        底图颜色即通行时间，POI 颜色随可达性变红 —— 换个出发点，看"15 分钟生活圈"是怎么变形的。
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
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 9px;
  font-size: 10.5px;
  color: #8fa0b3;
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lg i {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  display: inline-block;
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
