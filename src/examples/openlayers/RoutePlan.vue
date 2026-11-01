<script setup lang="ts">
/**
 * 路网路径规划
 * ===========================================================================
 * 补的是 GIS 分析里最经典的一块：网络分析。
 *
 * 这里不做"调个库算条路径"，而是把两个算法的差别摆出来：
 *   Dijkstra —— 以起点为圆心均匀扩散，访问节点数 = 到终点距离内几乎所有节点
 *   A*       —— 加一个「到终点的直线距离」启发，搜素偏向目标，访问数明显少
 *
 * 页面会把搜索顺序逐帧回放，所以能直接看到 Dijkstra 的「同心圆扩散」
 * 和 A* 的「朝目标扎过去」。两个数字（访问节点数、松弛次数）都来自真实计算。
 *
 * 权重支持「最短距离」和「最快时间」：后者把主干道（60km/h）与支路（30km/h）
 * 以及随机拥堵算进去，同一对起终点可能走出完全不同的路径。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import LineString from 'ol/geom/LineString'
import Style from 'ol/style/Style'
import Stroke from 'ol/style/Stroke'
import CircleStyle from 'ol/style/Circle'
import Fill from 'ol/style/Fill'
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj'
import type { FeatureLike } from 'ol/Feature'
import type { MapBrowserEvent } from 'ol'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import osmData from './data/hangzhou-roadnet.json'

/* ------------------------------ 路网生成 ------------------------------ */

const GRID = 26
const STEP = 0.0052
const LON0 = 119.995
const LAT0 = 30.205
const ROAD_SPEED = 60 // 主干道 km/h
const LOCAL_SPEED = 30 // 支路 km/h

interface Edge {
  a: number
  b: number
  /** 米 */
  dist: number
  /** 0~1 的速度系数，主干道更高 */
  speed: number
  /** 拥堵系数 ≥ 1 */
  jam: number
  /** 是否主干道 */
  arterial: boolean
}

function lonOf(i: number): number {
  return LON0 + i * STEP
}
function latOf(j: number): number {
  return LAT0 + j * STEP
}

/** 确定性随机，保证每次刷新路况一致 */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NODES: Array<{ lon: number; lat: number }> = []
const EDGES: Edge[] = []
const ADJ: number[][] = []

/** 清空当前图（切换数据源用） */
function clearGraph() {
  NODES.length = 0
  EDGES.length = 0
  ADJ.length = 0
}

/** 合成网格路网：完美网格 + 随机断头路，规模可控，适合讲算法 */
function loadSynthetic() {
  clearGraph()
  const rand = rng(20261101)
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      NODES.push({ lon: lonOf(i), lat: latOf(j) })
      ADJ.push([])
    }
  }
  const id = (i: number, j: number) => j * GRID + i
  const push = (a: number, b: number) => {
    // 随机封闭约 10% 的路段：真实城市有断头路、单行、施工封闭，
    // 完美网格会让 A* 几乎没有绕行压力，剪枝效果看不出来
    if (rand() < 0.1) return
    const pa = NODES[a]
    const pb = NODES[b]
    // 经度方向按纬度收缩，换算成真实米
    const dx = (pb.lon - pa.lon) * 111320 * Math.cos((pa.lat * Math.PI) / 180)
    const dy = (pb.lat - pa.lat) * 110540
    const dist = Math.hypot(dx, dy)
    const arterial = Math.min(a % GRID, b % GRID) % 6 === 0 || Math.min((a / GRID) | 0, (b / GRID) | 0) % 6 === 0
    const jam = 1 + rand() * 0.9
    const idx = EDGES.length
    EDGES.push({ a, b, dist, speed: arterial ? ROAD_SPEED : LOCAL_SPEED, jam, arterial })
    ADJ[a].push(idx)
    ADJ[b].push(idx)
  }
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      if (i + 1 < GRID) push(id(i, j), id(i + 1, j))
      if (j + 1 < GRID) push(id(i, j), id(i, j + 1))
    }
  }
}

/**
 * 真实路网（OpenStreetMap，杭州西湖东侧，约 3×3.5km）。
 * 数据由 scripts/fetch-osm-roadnet.mjs 预先抓取并精简后固化在 data/ 下，
 * 页面不依赖网络；速度按道路等级映射，拥堵是确定性随机的（刷新不变）。
 */
function loadOsm() {
  clearGraph()
  const rand = rng(20261101)
  for (const [lon, lat] of osmData.nodes) {
    NODES.push({ lon, lat })
    ADJ.push([])
  }
  for (const [a, b, speed] of osmData.edges) {
    const pa = NODES[a]
    const pb = NODES[b]
    const dx = (pb.lon - pa.lon) * 111320 * Math.cos((pa.lat * Math.PI) / 180)
    const dy = (pb.lat - pa.lat) * 110540
    const jam = 1 + rand() * 0.9
    const idx = EDGES.length
    EDGES.push({ a, b, dist: Math.hypot(dx, dy), speed, jam, arterial: speed >= 50 })
    ADJ[a].push(idx)
    ADJ[b].push(idx)
  }
}

/** 边权：距离模式取米，时间模式取秒 */
function edgeCost(e: Edge, mode: 'dist' | 'time'): number {
  if (mode === 'dist') return e.dist * (0.85 + 0.3 * (e.jam - 1))
  const v = ((e.speed / 3.6) * (0.55 + 0.45 * (1 / e.jam)))
  return e.dist / Math.max(1, v)
}

/* ------------------------------ 算法 ------------------------------ */

/** 二叉小顶堆 */
class MinHeap {
  private ids: number[] = []
  private pr: number[] = []

  get size(): number {
    return this.ids.length
  }

  push(id: number, priority: number) {
    this.ids.push(id)
    this.pr.push(priority)
    let i = this.ids.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.pr[p] <= this.pr[i]) break
      this.swap(i, p)
      i = p
    }
  }

  pop(): number {
    const top = this.ids[0]
    const lastId = this.ids.pop()!
    const lastPr = this.pr.pop()!
    if (this.ids.length) {
      this.ids[0] = lastId
      this.pr[0] = lastPr
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.ids.length && this.pr[l] < this.pr[m]) m = l
        if (r < this.ids.length && this.pr[r] < this.pr[m]) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }

  private swap(a: number, b: number) {
    const ti = this.ids[a]
    this.ids[a] = this.ids[b]
    this.ids[b] = ti
    const tp = this.pr[a]
    this.pr[a] = this.pr[b]
    this.pr[b] = tp
  }
}

function haversine(a: number, b: number): number {
  const pa = NODES[a]
  const pb = NODES[b]
  const dx = (pb.lon - pa.lon) * 111320 * Math.cos((pa.lat * Math.PI) / 180)
  const dy = (pb.lat - pa.lat) * 110540
  return Math.hypot(dx, dy)
}

interface SearchResult {
  order: number[]
  prev: Int32Array
  dist: number
  relaxed: number
  ms: number
  path: number[]
}

/**
 * 统一实现：A* 只是把入堆优先级从 g 换成 g + h。
 * h 用「到终点的球面距离 / 最快速度」——必须可采纳（不高估），否则解不再最优。
 */
function search(start: number, end: number, mode: 'dist' | 'time', astar: boolean): SearchResult {
  const t0 = performance.now()
  const n = NODES.length
  const g = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const order: number[] = []
  let relaxed = 0

  const maxSpeed = mode === 'dist' ? 1 : ROAD_SPEED / 3.6
  const heur = (v: number) => (astar ? haversine(v, end) / maxSpeed : 0)

  const heap = new MinHeap()
  g[start] = 0
  heap.push(start, heur(start))

  while (heap.size) {
    const u = heap.pop()
    if (done[u]) continue
    done[u] = 1
    order.push(u)
    if (u === end) break

    for (const ei of ADJ[u]) {
      const e = EDGES[ei]
      const v = e.a === u ? e.b : e.a
      if (done[v]) continue
      const nd = g[u] + edgeCost(e, mode)
      if (nd < g[v]) {
        g[v] = nd
        prev[v] = u
        relaxed++
        heap.push(v, nd + heur(v))
      }
    }
  }

  const path: number[] = []
  if (Number.isFinite(g[end])) {
    let cur = end
    while (cur !== -1) {
      path.push(cur)
      cur = prev[cur]
    }
    path.reverse()
  }

  return { order, prev, dist: g[end], relaxed, ms: performance.now() - t0, path }
}

/* ------------------------------ 状态 ------------------------------ */

const roadSource = ref<'osm' | 'synthetic'>('osm')
const algo = ref<'astar' | 'dijkstra'>('astar')
const mode = ref<'dist' | 'time'>('dist')
const startId = ref<number | null>(null)
const endId = ref<number | null>(null)
const playing = ref(false)
const progress = ref(0)

const stat = ref<{
  visited: number
  relaxed: number
  ms: number
  pathKm: number
  pathMin: number
  cmpA: number
  cmpD: number
} | null>(null)

const hint = ref('点击地图设置起点')

/* ------------------------------ 地图 ------------------------------ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlMap | null = null
let roadLayer: VectorLayer<Feature> | null = null
let dynSource: VectorSource | null = null
let pathFeature: Feature<LineString> | null = null
let raf = 0
let visitedIds: number[] = []
let prevArr: Int32Array | null = null
let cursor = 0
let speed = 2 // 每帧回放的节点数
const playState = ref<'idle' | 'playing' | 'paused' | 'done'>('idle')

const { zoomBy, toggleFullscreen } = useOlView(() => map, [0, 0], 13)
const { current: currentBasemap, create, apply } = useOlBasemap('dark')

/** 当前图的经纬度 bbox（切换数据源后要重算，不能写死） */
function dataExtent(): [number, number, number, number] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const p of NODES) {
    if (p.lon < w) w = p.lon
    if (p.lon > e) e = p.lon
    if (p.lat < s) s = p.lat
    if (p.lat > n) n = p.lat
  }
  const px = (e - w) * 0.02
  const py = (n - s) * 0.02
  return [w - px, s - py, e + px, n + py]
}

function reset() {
  const pad = (wrapRef.value?.clientWidth ?? 1200) < 900 ? [24, 24, 24, 24] : [30, 40, 30, 318]
  map
    ?.getView()
    .fit(transformExtent(dataExtent(), 'EPSG:4326', 'EPSG:3857'), { padding: pad as number[], duration: 300 })
}

/** 路网底图层：一次画完，主干道更亮更粗 */
function buildRoadLayer(): VectorLayer<Feature> {
  const src = new VectorSource()
  for (const e of EDGES) {
    const a = NODES[e.a]
    const b = NODES[e.b]
    const f = new Feature({
      geometry: new LineString([
        fromLonLat([a.lon, a.lat]),
        fromLonLat([b.lon, b.lat]),
      ]),
      arterial: e.arterial,
    })
    src.addFeature(f)
  }
  return new VectorLayer({
    source: src,
    style: (f: FeatureLike) =>
      new Style({
        stroke: new Stroke({
          color: f.get('arterial') ? 'rgba(140, 176, 210, 0.85)' : 'rgba(96, 120, 146, 0.55)',
          width: f.get('arterial') ? 2 : 1,
        }),
      }),
  })
}

const dynStyle = (f: FeatureLike): Style => {
  const kind = f.get('kind') as string
  if (kind === 'path') {
    return new Style({ stroke: new Stroke({ color: '#4f9dff', width: 4.5 }) })
  }
  if (kind === 'visited') {
    const t = Number(f.get('t') ?? 0)
    // 青绿系、越晚越亮：与蓝色的规划路径拉开色相，否则两色叠在一起分不清
    const hue = 158 + t * 42
    return new Style({ stroke: new Stroke({ color: `hsla(${hue}, 82%, 58%, ${0.3 + t * 0.5})`, width: 1.8 }) })
  }
  if (kind === 'node') {
    return new Style({
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({ color: String(f.get('color') ?? '#4f9dff') }),
        stroke: new Stroke({ color: '#0b1218', width: 2 }),
      }),
    })
  }
  return new Style({})
}

function setEndpoint(which: 'start' | 'end', id: number) {
  if (dynSource) {
    // 端点单独标记
    const stale = dynSource.getFeatures().filter((f) => f.get('kind') === 'node' && f.get('which') === which)
    for (const f of stale) dynSource.removeFeature(f)
    const n = NODES[id]
    dynSource.addFeature(
      new Feature({
        geometry: new Point(fromLonLat([n.lon, n.lat])),
        kind: 'node',
        which,
        color: which === 'start' ? '#46d39a' : '#ff6b4a',
      }),
    )
  }
  if (which === 'start') startId.value = id
  else endId.value = id
}

function nearestNode(lon: number, lat: number): number {
  let best = 0
  let bd = Infinity
  for (let k = 0; k < NODES.length; k++) {
    const n = NODES[k]
    const d = (n.lon - lon) ** 2 + (n.lat - lat) ** 2
    if (d < bd) {
      bd = d
      best = k
    }
  }
  return best
}

function clearDynamic(keepEndpoints = true) {
  if (!dynSource) return
  const keep = keepEndpoints ? dynSource.getFeatures().filter((f) => f.get('kind') === 'node') : []
  dynSource.clear()
  for (const f of keep) dynSource.addFeature(f)
  pathFeature = null
}

/** 执行搜索并开始回放 */
function run() {
  if (startId.value == null || endId.value == null) return
  const s = startId.value
  const e = endId.value
  const astar = algo.value === 'astar'

  clearDynamic(true)
  const res = search(s, e, mode.value, astar)

  // 对照：另一个算法也跑一遍，拿到访问节点数做对比
  const other = search(s, e, mode.value, !astar)

  // 路径长度与耗时（按真实道路属性算，不受算法影响）
  let distM = 0
  let seconds = 0
  for (let i = 1; i < res.path.length; i++) {
    const a = res.path[i - 1]
    const b = res.path[i]
    const ei = ADJ[a].find((k) => EDGES[k].a === b || EDGES[k].b === b)
    if (ei == null) continue
    const edge = EDGES[ei]
    distM += edge.dist
    seconds += edge.dist / ((edge.speed / 3.6) * (0.55 + 0.45 / edge.jam))
  }

  stat.value = {
    visited: res.order.length,
    relaxed: res.relaxed,
    ms: res.ms,
    pathKm: distM / 1000,
    pathMin: seconds / 60,
    cmpA: astar ? res.order.length : other.order.length,
    cmpD: astar ? other.order.length : res.order.length,
  }

  // 最终路径先不画：等搜索回放结束再出现，否则一开始就是答案，看不出扩散过程
  pathFeature =
    res.path.length > 1
      ? new Feature({
          geometry: new LineString(res.path.map((id) => fromLonLat([NODES[id].lon, NODES[id].lat]))),
          kind: 'path',
        })
      : null

  visitedIds = res.order
  prevArr = res.prev
  cursor = 0
  progress.value = 0
  playing.value = true
  playState.value = 'playing'
  loop()
}

/** 逐帧回放访问顺序：每帧把「刚被访问的节点 + 它的前驱边」加进动态图层 */
function loop() {
  cancelAnimationFrame(raf)
  if (!playing.value || !dynSource || !prevArr) return
  const next = Math.min(visitedIds.length, cursor + speed)
  for (let k = cursor; k < next; k++) {
    const id = visitedIds[k]
    const p = prevArr[id]
    if (p < 0) continue
    dynSource.addFeature(
      new Feature({
        geometry: new LineString([
          fromLonLat([NODES[p].lon, NODES[p].lat]),
          fromLonLat([NODES[id].lon, NODES[id].lat]),
        ]),
        kind: 'visited',
        t: k / Math.max(1, visitedIds.length),
      }),
    )
  }
  cursor = next
  progress.value = visitedIds.length ? cursor / visitedIds.length : 1
  if (cursor >= visitedIds.length) {
    playing.value = false
    playState.value = 'done'
    if (pathFeature && dynSource) dynSource.addFeature(pathFeature)
    return
  }
  raf = requestAnimationFrame(loop)
}

function togglePlay() {
  if (playing.value) {
    playing.value = false
    playState.value = 'paused'
    cancelAnimationFrame(raf)
    return
  }
  if (playState.value === 'done' || cursor >= visitedIds.length) {
    run() // 重播整段搜索
    return
  }
  if (!visitedIds.length) return
  playing.value = true
  playState.value = 'playing'
  loop()
}

function clearAll() {
  cancelAnimationFrame(raf)
  playing.value = false
  startId.value = null
  endId.value = null
  stat.value = null
  visitedIds = []
  prevArr = null
  cursor = 0
  playState.value = 'idle'
  progress.value = 0
  clearDynamic(false)
  hint.value = '点击地图设置起点'
}

function onMapClick(evt: MapBrowserEvent<MouseEvent>) {
  const [wlon, wlat] = toLonLat(evt.coordinate)
  const id = nearestNode(wlon, wlat)
  if (startId.value == null) {
    setEndpoint('start', id)
    hint.value = '再点一次设置终点'
  } else {
    setEndpoint('end', id)
    hint.value = '已计算，点击地图可重设终点'
    run()
  }
}

/**
 * 切换路网数据源并立刻重算一对默认起终点。
 * 真实路网和合成网格的坐标范围完全不同，所以 bbox、视图、起终点都要重来。
 */
function loadGraph(kind: 'osm' | 'synthetic') {
  roadSource.value = kind
  if (kind === 'osm') loadOsm()
  else loadSynthetic()

  // 路网底图必须跟着换：只换数据不重建图层，地图上还是旧路网（第一次切换就露馅）
  if (map && roadLayer) {
    map.removeLayer(roadLayer)
    roadLayer = buildRoadLayer()
    map.getLayers().insertAt(1, roadLayer)
  }

  clearAll()
  reset()

  const [w, s, e, n] = dataExtent()
  setEndpoint('start', nearestNode(w + (e - w) * 0.16, s + (n - s) * 0.16))
  setEndpoint('end', nearestNode(e - (e - w) * 0.2, n - (n - s) * 0.2))
  hint.value = kind === 'osm' ? '真实路网 · 点击地图可重设起终点' : '合成网格路网 · 点击地图可重设起终点'
  run()
}

function setAlgo(a: 'astar' | 'dijkstra') {
  algo.value = a
  if (startId.value != null && endId.value != null) run()
}

function setMode(m: 'dist' | 'time') {
  mode.value = m
  if (startId.value != null && endId.value != null) run()
}

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(() => {
  const base = create()
  roadLayer = buildRoadLayer()
  dynSource = new VectorSource()
  const dynLayer = new VectorLayer({ source: dynSource, style: dynStyle, zIndex: 10 })

  map = new OlMap({
    target: container.value!,
    layers: [base, roadLayer, dynLayer],
    view: new View({ center: fromLonLat([LON0 + 0.065, LAT0 + 0.065]), zoom: 13, minZoom: 10, maxZoom: 17 }),
  })
  map.on('singleclick', onMapClick)
  loadGraph('osm')
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  map?.setTarget(undefined)
  map = null
  roadLayer = null
  dynSource = null
})

const progressPct = computed(() => Math.round(progress.value * 100))
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>

    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="apply"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <!-- 左上：算法 -->
    <div class="panel left">
      <div class="head">
        <span>路网路径规划</span>
        <span class="src">{{ NODES.length }} 节点 · {{ EDGES.length }} 路段</span>
      </div>

      <div class="label">路网数据</div>
      <div class="segs">
        <button class="seg" :class="{ on: roadSource === 'osm' }" @click="loadGraph('osm')">
          杭州真实<i>OSM · {{ osmData.meta.ways }} 条路</i>
        </button>
        <button class="seg" :class="{ on: roadSource === 'synthetic' }" @click="loadGraph('synthetic')">
          合成网格<i>26×26 · 可控</i>
        </button>
      </div>

      <div class="label">算法</div>
      <div class="segs">
        <button class="seg" :class="{ on: algo === 'astar' }" @click="setAlgo('astar')">
          A*<i>启发式</i>
        </button>
        <button class="seg" :class="{ on: algo === 'dijkstra' }" @click="setAlgo('dijkstra')">
          Dijkstra<i>无启发</i>
        </button>
      </div>

      <div class="label">权重</div>
      <div class="segs">
        <button class="seg" :class="{ on: mode === 'dist' }" @click="setMode('dist')">
          最短距离<i>考虑拥堵</i>
        </button>
        <button class="seg" :class="{ on: mode === 'time' }" @click="setMode('time')">
          最快时间<i>主干道优先</i>
        </button>
      </div>

      <div class="bar">
        <div class="track"><span :style="{ width: progressPct + '%' }"></span></div>
        <span class="pct">{{ progressPct }}%</span>
      </div>

      <div class="plays">
        <button class="mini" @click="togglePlay">
          {{ playState === 'playing' ? '暂停' : playState === 'done' ? '重播' : playState === 'paused' ? '继续' : '开始' }}
        </button>
        <button class="mini" @click="clearAll">重置</button>
      </div>

      <div v-if="stat" class="stats">
        <div class="c"><b>{{ stat.visited }}</b><span>访问节点</span></div>
        <div class="c"><b>{{ stat.relaxed }}</b><span>松弛次数</span></div>
        <div class="c"><b>{{ stat.ms.toFixed(2) }}</b><span>计算 ms</span></div>
      </div>

      <div v-if="stat" class="route">
        <div class="r-row"><span>路径长度</span><b>{{ stat.pathKm.toFixed(2) }} km</b></div>
        <div class="r-row"><span>预计用时</span><b>{{ stat.pathMin.toFixed(1) }} min</b></div>
        <div class="r-row cmp">
          <span>A* / Dijkstra 访问数</span>
          <b>{{ stat.cmpA }} / {{ stat.cmpD }}</b>
        </div>
      </div>

      <div class="tip">{{ hint }}</div>
      <div class="tip sub">
        节点数只有几百时，A* 每次入堆多算一次启发，耗时会略高于 Dijkstra ——
        剪枝收益要到百万级真实路网才明显。
      </div>
    </div>

    <!-- 左下：图例 -->
    <div class="panel legend">
      <div class="row"><span class="line" style="background: #8cb0d2"></span>主干道 60km/h</div>
      <div class="row"><span class="line thin" style="background: #607892"></span>支路 30km/h</div>
      <div class="row"><span class="line" style="background: #4f9dff"></span>规划路径</div>
      <div class="row"><span class="line" style="background: #4fd0c0"></span>搜索足迹</div>
      <div class="row"><span class="dot" style="background: #46d39a"></span>起点<span class="dot red"></span>终点</div>
      <div v-if="roadSource === 'osm'" class="crop">
        路网数据 © OpenStreetMap contributors · ODbL 1.0
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.ol-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  z-index: 20;
  border-radius: 11px;
  background: rgba(14, 20, 29, 0.92);
  border: 1px solid rgba(90, 112, 138, 0.4);
  color: #d7e2ee;
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
  font-size: 12px;
}

.left {
  left: 14px;
  top: 14px;
  width: 286px;
  padding: 11px 12px 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.25);
  font-size: 12px;
  font-weight: 600;
  color: #eaf2fb;
}
.src {
  font-size: 9.5px;
  font-weight: 400;
  color: #6f8296;
}
.label {
  margin: 10px 0 6px;
  font-size: 10px;
  color: #7d8fa3;
  letter-spacing: 0.04em;
}
.segs {
  display: flex;
  gap: 5px;
}
.seg {
  flex: 1;
  padding: 6px 4px;
  border-radius: 6px;
  border: 1px solid rgba(90, 112, 138, 0.38);
  background: transparent;
  color: #c3cfdb;
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.seg i {
  display: block;
  font-style: normal;
  font-size: 9px;
  color: #5d7186;
  margin-top: 2px;
}
.seg:hover {
  border-color: rgba(79, 157, 255, 0.5);
}
.seg.on {
  background: rgba(79, 157, 255, 0.16);
  border-color: rgba(79, 157, 255, 0.62);
  color: #eaf2fb;
}
.seg.on i {
  color: #7bbcff;
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
}
.track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(90, 112, 138, 0.3);
  overflow: hidden;
}
.track span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #2f6fd0, #4fd0c0);
  transition: width 0.08s linear;
}
.pct {
  font-size: 9.5px;
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
  width: 32px;
  text-align: right;
}
.plays {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.mini {
  flex: 1;
  padding: 5px 0;
  border-radius: 6px;
  border: 1px solid rgba(90, 112, 138, 0.5);
  background: transparent;
  color: #a9bccf;
  font-size: 10.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.mini:hover {
  border-color: #4f9dff;
  color: #7bbcff;
}

.stats {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.c {
  flex: 1;
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(28, 38, 52, 0.75);
  border: 1px solid rgba(90, 112, 138, 0.22);
}
.c b {
  display: block;
  font-size: 13px;
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
.c span {
  font-size: 9px;
  color: #7d8fa3;
}

.route {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px dashed rgba(90, 112, 138, 0.25);
}
.r-row {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: #8fa4b9;
  padding: 2px 0;
}
.r-row b {
  color: #cfe0f2;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.r-row.cmp b {
  color: #ffb45c;
}
.tip {
  margin-top: 9px;
  font-size: 10px;
  color: #6f8296;
  line-height: 1.45;
}
.tip.sub {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px dashed rgba(90, 112, 138, 0.2);
  color: #5d7186;
  font-size: 9.5px;
}

/* 图例 */
.legend {
  left: 14px;
  bottom: 14px;
  width: 286px;
  padding: 9px 11px 10px;
}
.legend .row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  color: #a9bccf;
  padding: 2.5px 0;
}
.line {
  width: 22px;
  height: 3px;
  border-radius: 2px;
  flex: none;
}
.line.thin {
  height: 2px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  display: inline-block;
  margin-left: 2px;
}
.dot.red {
  background: #ff6b4a;
  margin-left: 6px;
}
.crop {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(90, 112, 138, 0.22);
  font-size: 9px;
  color: #5d7186;
  line-height: 1.4;
}
</style>
