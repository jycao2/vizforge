<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { LineString, Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { getDistance } from 'ol/sphere'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import type TileSource from 'ol/source/Tile'
import type { FeatureLike } from 'ol/Feature'
import MapControls from '@/components/MapControls.vue'
import { useOlView } from './useOl'
import { OL_BASEMAPS, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
// 默认用影像：街道图在 z14+ 的国内区域会返回「Map data not yet available」占位瓦片，
// 而影像每一级都有真实数据，偏移量才看得出参照
const currentBasemap = ref('imagery')
let map: OlMap | null = null
let baseLayer: TileLayer<TileSource> | null = null

/* ------------------------------------------------------------------ *
 * 三套坐标系互相转换（GCJ-02 的公开偏移算法 + BD-09 的再偏一次）
 * ------------------------------------------------------------------ */
const PI = Math.PI
const A = 6378245.0
const EE = 0.00669342162296594323

/** 国境之外不做偏移（GCJ-02 只在国内生效） */
function outOfChina(lng: number, lat: number) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55)
}

function transformLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
  return r
}

function transformLng(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
  return r
}

function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return [lng + dLng, lat + dLat]
}

/** GCJ-02 没有解析反函数，用不动点迭代逼近（8 次足够到厘米级） */
function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  let wl = lng
  let wa = lat
  for (let i = 0; i < 8; i++) {
    const [gl, ga] = wgs84ToGcj02(wl, wa)
    wl += lng - gl
    wa += lat - ga
  }
  return [wl, wa]
}

function gcj02ToBd09(lng: number, lat: number): [number, number] {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin((lat * PI * 3000) / 180)
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos((lng * PI * 3000) / 180)
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006]
}

function bd09ToGcj02(lng: number, lat: number): [number, number] {
  const x = lng - 0.0065
  const y = lat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin((y * PI * 3000) / 180)
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos((x * PI * 3000) / 180)
  return [z * Math.cos(theta), z * Math.sin(theta)]
}

type Crs = 'wgs84' | 'gcj02' | 'bd09'

const CRS_LABEL: Record<Crs, string> = { wgs84: 'WGS84', gcj02: 'GCJ-02 火星坐标', bd09: 'BD-09 百度坐标' }

/** 任一坐标系 → WGS84（叠加到 WGS84 底图前必须走这一步） */
function toWgs84(lng: number, lat: number, from: Crs): [number, number] {
  if (from === 'wgs84') return [lng, lat]
  if (from === 'gcj02') return gcj02ToWgs84(lng, lat)
  const [gl, ga] = bd09ToGcj02(lng, lat)
  return gcj02ToWgs84(gl, ga)
}

/** WGS84 → 任一坐标系 */
function fromWgs84(lng: number, lat: number, to: Crs): [number, number] {
  if (to === 'wgs84') return [lng, lat]
  const [gl, ga] = wgs84ToGcj02(lng, lat)
  return to === 'gcj02' ? [gl, ga] : gcj02ToBd09(gl, ga)
}

/* ------------------------------------------------------------------ *
 * 城市与样例点位
 * ------------------------------------------------------------------ */
const CITIES = [
  { id: 'bj', name: '北京', lng: 116.397, lat: 39.909 },
  { id: 'sh', name: '上海', lng: 121.473, lat: 31.23 },
  { id: 'hz', name: '杭州', lng: 120.155, lat: 30.274 },
  { id: 'gz', name: '广州', lng: 113.264, lat: 23.129 },
  { id: 'wlmq', name: '乌鲁木齐', lng: 87.617, lat: 43.792 },
]

const CRS_LIST: Crs[] = ['wgs84', 'gcj02', 'bd09']
const cityId = ref('hz')
const sourceCrs = ref<Crs>('gcj02')
const fixed = ref(false)
const city = computed(() => CITIES.find((c) => c.id === cityId.value) ?? CITIES[0])

/** 以城市中心为原点撒一圈点位（真实坐标先按 WGS84 定义） */
function samplePoints(lng0: number, lat0: number) {
  const out: Array<{ name: string; lng: number; lat: number }> = []
  const rnd = (i: number) => Math.sin(i * 12.9898) * 43758.5453
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.4
    const r = 0.004 + ((rnd(i) % 1) + 1) % 1 * 0.012
    const lng = lng0 + Math.cos(a) * r
    const lat = lat0 + Math.sin(a) * r * 0.72
    out.push({ name: `点位 ${String(i + 1).padStart(2, '0')}`, lng, lat })
  }
  out.push({ name: '城市中心', lng: lng0, lat: lat0 })
  return out
}

/* ------------------------------------------------------------------ *
 * 图层
 * ------------------------------------------------------------------ */
let vLayer: VectorLayer<Feature> | null = null
let vSource: VectorSource | null = null

const stats = ref({ avg: 0, max: 0, dir: '' })

const styleWrong = new Style({
  image: new CircleStyle({
    radius: 5.5,
    fill: new Fill({ color: 'rgba(255,82,82,0.16)' }),
    stroke: new Stroke({ color: '#ff5252', width: 1.8, lineDash: [4, 3] }),
  }),
})

const styleRight = new Style({
  image: new CircleStyle({
    radius: 4.5,
    fill: new Fill({ color: '#2ee6a8' }),
    stroke: new Stroke({ color: 'rgba(4,12,10,0.9)', width: 1.4 }),
  }),
})

/** 纠偏后：原来的错误位置留一个很淡的空心圈，位移线才有起点 */
const styleGhost = new Style({
  image: new CircleStyle({
    radius: 2.6,
    fill: new Fill({ color: 'rgba(255,82,82,0.25)' }),
    stroke: new Stroke({ color: 'rgba(255,82,82,0.55)', width: 1 }),
  }),
})

const styleLink = new Style({
  stroke: new Stroke({ color: 'rgba(255,180,90,0.75)', width: 1.6, lineDash: [5, 4] }),
})

const labelCache = new Map<string, Style>()

function labelStyle(text: string, offsetY: number, color: string) {
  const key = `${text}|${offsetY}`
  const hit = labelCache.get(key)
  if (hit) return hit
  const st = makeLabelStyle(text, offsetY, color)
  labelCache.set(key, st)
  return st
}

function makeLabelStyle(text: string, offsetY: number, color: string) {
  return new Style({
    text: new Text({
      text,
      font: '11px sans-serif',
      offsetY,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: 'rgba(4,10,16,0.85)', width: 2.6 }),
    }),
  })
}

function rebuild() {
  if (!vSource) return
  vSource.clear()
  const c = city.value
  const pts = samplePoints(c.lng, c.lat)

  let sum = 0
  let max = 0
  let dirLng = 0
  let dirLat = 0

  for (const p of pts) {
    // 业务系统里的坐标（按所选坐标系表达同一批真实地点）
    const [dl, da] = fromWgs84(p.lng, p.lat, sourceCrs.value)
    // 纠偏后应该落到的位置
    const [tl, ta] = toWgs84(dl, da, sourceCrs.value)
    // 不纠偏直接当 WGS84 用 → 落在错误位置
    const wrongPt = fromLonLat([dl, da])
    const rightPt = fromLonLat([tl, ta])

    const dist = getDistance([dl, da], [tl, ta])
    sum += dist
    if (dist > max) max = dist
    dirLng += dl - tl
    dirLat += da - ta

    const offsetM = Math.round(dist)
    if (fixed.value) {
      vSource.addFeature(new Feature({ geometry: new Point(wrongPt), kind: 'ghost' }))
    } else {
      vSource.addFeature(new Feature({ geometry: new Point(wrongPt), kind: 'wrong' }))
    }
    vSource.addFeature(new Feature({ geometry: new Point(rightPt), kind: 'right' }))
    const link = new Feature({
      geometry: new LineString([wrongPt, rightPt]),
      kind: 'link',
      tip: `${offsetM} m`,
    })
    vSource.addFeature(link)
    if (offsetM > 20) {
      vSource.addFeature(
        new Feature({
          geometry: new Point([(wrongPt[0] + rightPt[0]) / 2, (wrongPt[1] + rightPt[1]) / 2]),
          kind: 'label',
          tip: `${offsetM} m`,
        }),
      )
    }
  }

  const n = pts.length
  stats.value = {
    avg: Math.round(sum / n),
    max: Math.round(max),
    dir: `${dirLng / n >= 0 ? '东' : '西'}${dirLat / n >= 0 ? '北' : '南'}`,
  }
}

function styleFn(f: FeatureLike) {
  const kind = f.get('kind') as string
  if (kind === 'wrong') return styleWrong
  if (kind === 'ghost') return styleGhost
  if (kind === 'right') return styleRight
  if (kind === 'link') return styleLink
  return labelStyle(String(f.get('tip')), -12, '#ffcf80')
}

/* ------------------------------------------------------------------ *
 * 视图与交互
 * ------------------------------------------------------------------ */
const home = computed(() => fromLonLat([city.value.lng, city.value.lat]))
const HOME_ZOOM = 16
const { zoomBy, toggleFullscreen } = useOlView(() => map, home.value, HOME_ZOOM)

/** home 会随城市变，脚手架只在创建时取一次，所以复位自己实现 */
function reset() {
  map?.getView().animate({ center: home.value, zoom: HOME_ZOOM, duration: 380 })
}

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
}

watch(cityId, () => {
  reset()
  rebuild()
})
watch([sourceCrs, fixed], rebuild)

const centerReadout = computed(() => {
  const c = city.value
  const g = wgs84ToGcj02(c.lng, c.lat)
  const b = gcj02ToBd09(g[0], g[1])
  return {
    wgs: `${c.lng.toFixed(6)}, ${c.lat.toFixed(6)}`,
    gcj: `${g[0].toFixed(6)}, ${g[1].toFixed(6)}`,
    bd: `${b[0].toFixed(6)}, ${b[1].toFixed(6)}`,
    dGcj: Math.round(getDistance([c.lng, c.lat], g)),
    dBd: Math.round(getDistance([c.lng, c.lat], b)),
  }
})

onMounted(() => {
  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })
  vSource = new VectorSource()
  vLayer = new VectorLayer({ source: vSource, style: styleFn, updateWhileInteracting: true })

  map = new OlMap({
    target: container.value,
    layers: [baseLayer!, vLayer!],
    view: new View({ center: home.value, zoom: HOME_ZOOM, minZoom: 3, maxZoom: 19 }),
    controls: [],
  })
  rebuild()
})
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
          <div class="name">坐标系纠偏 · WGS84 / GCJ-02 / BD-09</div>
          <div class="url">底图是 WGS84，业务数据多半是 GCJ-02</div>
        </div>
      </div>

      <div class="sec">城市</div>
      <div class="chips">
        <button v-for="c in CITIES" :key="c.id" class="chip" :class="{ on: c.id === cityId }" @click="cityId = c.id">
          {{ c.name }}
        </button>
      </div>

      <div class="sec">业务数据的坐标系</div>
      <div class="chips">
        <button
          v-for="c in CRS_LIST"
          :key="c"
          class="chip"
          :class="{ on: c === sourceCrs }"
          @click="sourceCrs = c"
        >
          {{ c.toUpperCase() }}
        </button>
      </div>

      <button class="switch" :class="{ on: fixed }" @click="fixed = !fixed">
        <span class="track"><span class="knob"></span></span>
        <span class="sw-label">纠偏（转到 WGS84 再落图）</span>
      </button>

      <div class="stats">
        <div class="st"><b>{{ stats.avg }} m</b><span>平均偏移</span></div>
        <div class="st"><b>{{ stats.max }} m</b><span>最大偏移</span></div>
        <div class="st"><b>{{ stats.dir }}</b><span>偏移方向</span></div>
      </div>

      <div class="table">
        <div class="tr"><span>WGS84</span><b>{{ centerReadout.wgs }}</b></div>
        <div class="tr"><span>GCJ-02</span><b>{{ centerReadout.gcj }}</b></div>
        <div class="tr"><span>BD-09</span><b>{{ centerReadout.bd }}</b></div>
        <div class="tr note">
          <span>中心点偏移</span><b>GCJ {{ centerReadout.dGcj }} m · BD {{ centerReadout.dBd }} m</b>
        </div>
      </div>

      <div class="legend">
        <span><i class="k wrong"></i>{{ fixed ? '原位置' : '未纠偏' }}</span>
        <span><i class="k right"></i>纠偏后</span>
        <span><i class="k link"></i>位移</span>
      </div>
      <div class="hint">
        绿点是真实位置（与影像地物对齐）。关掉纠偏，红虚圈就是「数据直接当 WGS84 用」的落点，
        相距几百米——放在市区级缩放下几乎必然错到隔壁街区。
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
  width: 274px;
  padding: 11px 12px 12px;
  border-radius: 11px;
  background: rgba(14, 20, 29, 0.93);
  border: 1px solid rgba(90, 112, 138, 0.4);
  color: #d7e2ee;
  font-size: 12px;
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
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
  background: #2ee6a8;
  box-shadow: 0 0 8px #2ee6a8;
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
.sec {
  margin: 9px 0 5px;
  font-size: 10.5px;
  color: #7d8fa3;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid rgba(90, 112, 138, 0.5);
  background: transparent;
  color: #a9bccf;
  font-size: 11px;
  cursor: pointer;
}
.chip:hover {
  border-color: #4f9dff;
}
.chip.on {
  background: #2f6fd0;
  border-color: #2f6fd0;
  color: #fff;
}
.switch {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
  width: 100%;
  padding: 6px 7px;
  border-radius: 7px;
  border: 1px solid rgba(90, 112, 138, 0.4);
  background: rgba(255, 255, 255, 0.03);
  color: #c6d5e5;
  font-size: 11.5px;
  cursor: pointer;
}
.track {
  width: 26px;
  height: 14px;
  border-radius: 8px;
  background: rgba(120, 145, 170, 0.4);
  position: relative;
  flex: none;
  transition: background 0.18s ease;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e8f1fb;
  transition: transform 0.18s ease;
}
.switch.on .track {
  background: #2ee6a8;
}
.switch.on .knob {
  transform: translateX(12px);
}
.sw-label {
  white-space: nowrap;
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
  font-size: 12.5px;
  color: #eaf2fb;
}
.st span {
  font-size: 9.5px;
  color: #7d8fa3;
}
.table {
  margin-top: 9px;
  padding: 7px 8px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(90, 112, 138, 0.22);
}
.tr {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10.5px;
  line-height: 1.75;
}
.tr span {
  color: #7d8fa3;
  flex: none;
}
.tr b {
  color: #cfdcea;
  font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
}
.tr.note {
  margin-top: 3px;
  padding-top: 4px;
  border-top: 1px solid rgba(90, 112, 138, 0.2);
}
.legend {
  display: flex;
  gap: 12px;
  margin-top: 9px;
  font-size: 10.5px;
  color: #9fb0c2;
}
.legend span {
  display: flex;
  align-items: center;
  gap: 4px;
}
.k {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}
.k.wrong {
  border: 2px dashed #ff5252;
  background: rgba(255, 82, 82, 0.15);
}
.k.right {
  background: #2ee6a8;
}
.k.link {
  width: 12px;
  height: 0;
  border-radius: 0;
  border-top: 2px dashed rgba(255, 180, 90, 0.9);
}
.hint {
  margin-top: 8px;
  font-size: 10.5px;
  line-height: 1.6;
  color: #7d8fa3;
}
</style>
