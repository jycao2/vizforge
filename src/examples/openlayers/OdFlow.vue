<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { LineString, Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import type { FeatureLike } from 'ol/Feature'
import type { Coordinate } from 'ol/coordinate'
import type TileSource from 'ol/source/Tile'
import MapControls from '@/components/MapControls.vue'
import { useOlView } from './useOl'
import { OL_BASEMAPS, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref('dark')
let map: OlMap | null = null
let baseLayer: TileLayer<TileSource> | null = null

/* ------------------------------------------------------------------ *
 * 城市与 OD 数据
 * ------------------------------------------------------------------ */
interface City {
  name: string
  lng: number
  lat: number
}

const CITIES: City[] = [
  { name: '北京', lng: 116.41, lat: 39.9 },
  { name: '上海', lng: 121.47, lat: 31.23 },
  { name: '广州', lng: 113.26, lat: 23.13 },
  { name: '深圳', lng: 114.06, lat: 22.55 },
  { name: '成都', lng: 104.07, lat: 30.57 },
  { name: '西安', lng: 108.94, lat: 34.34 },
  { name: '武汉', lng: 114.3, lat: 30.59 },
  { name: '杭州', lng: 120.15, lat: 30.27 },
  { name: '南京', lng: 118.8, lat: 32.06 },
  { name: '重庆', lng: 106.55, lat: 29.56 },
  { name: '沈阳', lng: 123.43, lat: 41.8 },
  { name: '哈尔滨', lng: 126.64, lat: 45.76 },
  { name: '郑州', lng: 113.63, lat: 34.75 },
  { name: '长沙', lng: 112.94, lat: 28.23 },
  { name: '昆明', lng: 102.83, lat: 24.88 },
  { name: '乌鲁木齐', lng: 87.62, lat: 43.79 },
  { name: '拉萨', lng: 91.14, lat: 29.65 },
  { name: '青岛', lng: 120.38, lat: 36.07 },
  { name: '厦门', lng: 118.09, lat: 24.48 },
  { name: '兰州', lng: 103.83, lat: 36.06 },
  { name: '呼和浩特', lng: 111.75, lat: 40.84 },
  { name: '海口', lng: 110.2, lat: 20.04 },
]

const HUBS = ['北京', '上海', '广州', '成都', '乌鲁木齐', '哈尔滨']

interface Od {
  from: City
  to: City
  flow: number
}

function rnd(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

const ODS: Od[] = []
HUBS.forEach((hubName, hi) => {
  const hub = CITIES.find((c) => c.name === hubName)!
  const targets = CITIES.filter((c) => c.name !== hubName)
  targets.forEach((t, ti) => {
    // 每个枢纽连一半的城市，流量取 20~180，让线宽有层次
    if ((hi + ti) % 2 === 0) return
    const flow = Math.round(20 + rnd(hi * 31 + ti * 7) * 160)
    ODS.push({ from: hub, to: t, flow })
  })
})

const totalFlow = ODS.reduce((s, o) => s + o.flow, 0)
const maxFlow = Math.max(...ODS.map((o) => o.flow))

/* ------------------------------------------------------------------ *
 * 弧线：投影坐标里的二次贝塞尔，控制点沿中垂线外推
 * ------------------------------------------------------------------ */
const SEGMENTS = 64

function quadPoint(a: Coordinate, c: Coordinate, b: Coordinate, t: number): Coordinate {
  const mt = 1 - t
  return [
    mt * mt * a[0] + 2 * mt * t * c[0] + t * t * b[0],
    mt * mt * a[1] + 2 * mt * t * c[1] + t * t * b[1],
  ]
}

function arcOf(o: Od, bend: number) {
  const a = fromLonLat([o.from.lng, o.from.lat])
  const b = fromLonLat([o.to.lng, o.to.lat])
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  // 法线方向外推，弧高按跨度比例走：跨 3000km 的弧不会比跨 300km 的还平
  const nx = -dy / len
  const ny = dx / len
  const sign = dy >= 0 ? -1 : 1
  const c: Coordinate = [
    (a[0] + b[0]) / 2 + nx * len * bend * sign,
    (a[1] + b[1]) / 2 + ny * len * bend * sign,
  ]
  const pts: Coordinate[] = []
  for (let i = 0; i <= SEGMENTS; i++) pts.push(quadPoint(a, c, b, i / SEGMENTS))
  return { pts, a, c, b }
}

/* ------------------------------------------------------------------ *
 * 图层与样式
 * ------------------------------------------------------------------ */
let arcSource: VectorSource | null = null
let citySource: VectorSource | null = null
let dotSource: VectorSource | null = null
let arcLayer: VectorLayer<Feature> | null = null
let cityLayer: VectorLayer<Feature> | null = null
let dotLayer: VectorLayer<Feature> | null = null

interface ArcItem {
  od: Od
  a: Coordinate
  c: Coordinate
  b: Coordinate
  speed: number
  phase: number
  dot: Feature<Point>
}

const arcs: ArcItem[] = []

const bend = ref(0.22)
const speed = ref(1)
const showArc = ref(true)
const showFlow = ref(true)

const ARC_STYLES: Style[] = []

function arcStyleFor(flow: number) {
  const k = flow / maxFlow
  const idx = k > 0.66 ? 2 : k > 0.36 ? 1 : 0
  if (!ARC_STYLES[idx]) {
    const conf = [
      { c: 'rgba(70,150,220,0.62)', w: 1.1 },
      { c: 'rgba(110,200,255,0.78)', w: 1.9 },
      { c: 'rgba(255,190,90,0.92)', w: 2.4 },
    ][idx]
    ARC_STYLES[idx] = new Style({
      stroke: new Stroke({ color: conf.c, width: conf.w, lineDash: [10, 9], lineDashOffset: 0 }),
    })
  }
  return ARC_STYLES[idx]
}

const cityStyleCache = new Map<string, Style[]>()

function cityStyle(name: string, isHub: boolean): Style[] {
  const key = `${name}|${isHub}`
  const hit = cityStyleCache.get(key)
  if (hit) return hit
  const style = new Style({
    image: new CircleStyle({
      radius: isHub ? 5.2 : 3.4,
      fill: new Fill({ color: isHub ? '#ffcf80' : '#8fd3ff' }),
      stroke: new Stroke({ color: 'rgba(6,12,20,0.9)', width: 1.3 }),
    }),
    text: new Text({
      text: name,
      font: isHub ? 'bold 11px sans-serif' : '10px sans-serif',
      offsetY: isHub ? -13 : -11,
      fill: new Fill({ color: isHub ? '#ffe1ac' : '#bcd6ee' }),
      stroke: new Stroke({ color: 'rgba(4,10,16,0.8)', width: 2.4 }),
    }),
  })
  cityStyleCache.set(key, [style])
  return [style]
}

/** 端点淡出用分档样式：每帧 new Style 会让 GC 一直抖 */
const DOT_STYLES = Array.from({ length: 11 }, (_, i) => {
  const k = i / 10
  return new Style({
    image: new CircleStyle({
      radius: 2.6 * k,
      fill: new Fill({ color: `rgba(255,255,255,${0.95 * k})` }),
      stroke: new Stroke({ color: `rgba(120,200,255,${0.9 * k})`, width: 2.4 }),
    }),
  })
})

function arcStyleFn(f: FeatureLike) {
  return arcStyleFor(Number(f.get('flow') ?? 0))
}

function cityStyleFn(f: FeatureLike) {
  return cityStyle(String(f.get('name')), Boolean(f.get('hub')))
}

/* ------------------------------------------------------------------ *
 * 构建与动画
 * ------------------------------------------------------------------ */
function build() {
  if (!arcSource || !citySource || !dotSource) return
  arcSource.clear()
  citySource.clear()
  dotSource.clear()
  arcs.length = 0

  CITIES.forEach((c) => {
    citySource!.addFeature(
      new Feature({
        geometry: new Point(fromLonLat([c.lng, c.lat])),
        kind: 'city',
        name: c.name,
        hub: HUBS.includes(c.name),
      }),
    )
  })

  ODS.forEach((od, i) => {
    const { pts, a, c, b } = arcOf(od, bend.value)
    arcSource!.addFeature(
      new Feature({ geometry: new LineString(pts), kind: 'arc', flow: od.flow, label: `${od.from.name} → ${od.to.name}` }),
    )
    const dot = new Feature(new Point(pts[0]))
    dotSource!.addFeature(dot)
    arcs.push({
      od,
      a,
      c,
      b,
      speed: 0.055 + (od.flow / maxFlow) * 0.09,
      phase: (i * 0.137) % 1,
      dot,
    })
  })
  arcLayer?.changed()
}

let raf = 0
let last = 0
let dash = 0

function tick(now: number) {
  raf = requestAnimationFrame(tick)
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  if (!arcLayer) return

  dash -= dt * 26 * speed.value
  ARC_STYLES.forEach((s) => s.getStroke()?.setLineDashOffset(dash))

  if (showFlow.value) {
    for (const item of arcs) {
      item.phase = (item.phase + dt * item.speed * speed.value) % 1
      // 走到两端时淡出，避免光点在端点突然出现
      const t = item.phase
      item.dot.getGeometry()?.setCoordinates(quadPoint(item.a, item.c, item.b, t))
      const edge = Math.min(1, Math.min(t, 1 - t) / 0.08)
      item.dot.setStyle(DOT_STYLES[Math.round(edge * (DOT_STYLES.length - 1))])
    }
  }
  arcLayer.changed()
}

/* ------------------------------------------------------------------ *
 * 视图
 * ------------------------------------------------------------------ */
const HOME: Coordinate = fromLonLat([106.5, 34.5])
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, HOME, 4.4)

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
}

const picked = ref('')

onMounted(() => {
  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })
  arcSource = new VectorSource()
  citySource = new VectorSource()
  dotSource = new VectorSource()

  arcLayer = new VectorLayer({ source: arcSource, style: arcStyleFn, updateWhileAnimating: true })
  cityLayer = new VectorLayer({ source: citySource, style: cityStyleFn, declutter: true })
  dotLayer = new VectorLayer({ source: dotSource, style: DOT_STYLES[10] })

  map = new OlMap({
    target: container.value,
    layers: [baseLayer, arcLayer, cityLayer, dotLayer],
    view: new View({ center: HOME, zoom: 4.4, minZoom: 2, maxZoom: 12 }),
    controls: [],
  })

  map.on('click', (evt) => {
    const hit = map!.forEachFeatureAtPixel(evt.pixel, (f) => f, { hitTolerance: 5 })
    const label = hit?.get('label')
    picked.value = label ? String(label) : ''
  })

  build()
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})

// 弧高改了要重建几何
function rebuild() {
  build()
}

const stats = computed(() => ({
  arcs: ODS.length,
  flow: totalFlow,
  hub: HUBS.length,
}))
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>

    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="setBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <div class="head-text">
          <div class="name">OD 迁徙图 · 流向与流量</div>
          <div class="url">{{ stats.hub }} 个枢纽 · {{ stats.arcs }} 条 OD</div>
        </div>
      </div>

      <div class="stats">
        <div class="st"><b>{{ stats.arcs }}</b><span>OD 对</span></div>
        <div class="st"><b>{{ stats.flow }}</b><span>总流量</span></div>
        <div class="st"><b>{{ maxFlow }}</b><span>单条峰值</span></div>
      </div>

      <div class="ctrl">
        <span class="lab">弧高</span>
        <input v-model.number="bend" type="range" min="0.06" max="0.42" step="0.01" @change="rebuild" />
        <b>{{ bend.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">流速</span>
        <input v-model.number="speed" type="range" min="0.2" max="3" step="0.1" />
        <b>{{ speed.toFixed(1) }}×</b>
      </div>

      <div class="toggles">
        <button class="tg" :class="{ on: showFlow }" @click="showFlow = !showFlow; dotLayer?.setVisible(showFlow)">
          流光
        </button>
        <button class="tg" :class="{ on: showArc }" @click="showArc = !showArc; arcLayer?.setVisible(showArc)">
          弧线
        </button>
      </div>

      <div v-if="picked" class="pick">已选中：{{ picked }}</div>
      <div class="hint">
        弧线是<b>投影坐标里的二次贝塞尔</b>，控制点沿中垂线外推、弧高按跨度比例缩放；
        纯圆角大圆弧在墨卡托下会被拉扁，跨纬度大的线尤其明显。
        虚线 + 光点两层叠加做出流动感，点线可拾取。
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
  left: 14px;
  top: 14px;
  z-index: 20;
  width: 268px;
  padding: 11px 12px 12px;
  border-radius: 11px;
  background: rgba(12, 18, 27, 0.92);
  border: 1px solid rgba(90, 112, 138, 0.4);
  color: #d7e2ee;
  font-size: 12px;
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.3);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.25);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ffcf80;
  box-shadow: 0 0 8px #ffcf80;
  flex: none;
}
.head-text {
  min-width: 0;
}
.name {
  font-size: 12.5px;
  font-weight: 600;
  color: #eaf2fb;
  white-space: nowrap;
}
.url {
  font-size: 10px;
  color: #7d8fa3;
  margin-top: 2px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-top: 9px;
}
.st {
  padding: 6px 2px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  text-align: center;
}
.st b {
  display: block;
  font-size: 13px;
  color: #eaf2fb;
}
.st span {
  font-size: 9.5px;
  color: #7d8fa3;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}
.lab {
  font-size: 10.5px;
  color: #7d8fa3;
  width: 28px;
  flex: none;
}
.ctrl input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4f9dff;
  height: 3px;
}
.ctrl b {
  font-size: 10px;
  color: #a9bccf;
  width: 34px;
  text-align: right;
  flex: none;
  font-weight: 500;
}
.toggles {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}
.tg {
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid rgba(90, 112, 138, 0.5);
  background: transparent;
  color: #a9bccf;
  font-size: 10.5px;
  cursor: pointer;
}
.tg.on {
  background: #2f6fd0;
  border-color: #2f6fd0;
  color: #fff;
}
.pick {
  margin-top: 9px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 207, 128, 0.12);
  border: 1px solid rgba(255, 207, 128, 0.35);
  color: #ffe1ac;
  font-size: 11px;
}
.hint {
  margin-top: 9px;
  font-size: 10.5px;
  line-height: 1.6;
  color: #7d8fa3;
}
.hint b {
  color: #a9bccf;
}
</style>
