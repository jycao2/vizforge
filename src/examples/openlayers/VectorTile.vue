<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import VectorTileLayer from 'ol/layer/VectorTile'
import VectorTileSourceImpl from 'ol/source/VectorTile'
import VectorTile from 'ol/VectorTile'
import MVT from 'ol/format/MVT'
import { fromLonLat, toLonLat } from 'ol/proj'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import type { FeatureLike } from 'ol/Feature'
import type RenderFeature from 'ol/render/Feature'
import MapControls from '@/components/MapControls.vue'
import { useOlView } from './useOl'
import { encodeMvt, type MvtFeature, type MvtLayer } from '@/examples/shared/mvt'

const container = ref<HTMLDivElement>()
const wrapRef = ref<HTMLDivElement>()
let map: OlMap | null = null

const CENTER = fromLonLat([120.11, 30.25])
const HOME_ZOOM = 14

const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, HOME_ZOOM)

/* ------------------------------------------------------------------ *
 * 自造数据：一块「城市」范围，所有要素都在这个 bbox 里按经纬度规则生成
 * ------------------------------------------------------------------ */
const CITY = { lon0: 120.03, lon1: 120.19, lat0: 30.19, lat1: 30.31 }
const EXT = 4096

const vis = reactive<Record<string, boolean>>({ water: true, road: true, building: true, poi: true })
const stats = reactive({ z: HOME_ZOOM, tiles: 0, feats: 0, bytes: 0 })
const picked = ref<Array<[string, string]>>([])
const pickedLayer = ref('')
const paused = ref(false)

function mulberry(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(a: number, b: number, c: number) {
  let h = Math.imul(a + 7, 374761393) ^ Math.imul(b + 13, 668265263) ^ Math.imul(c + 29, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** 河流中心线：全局函数，跨瓦片天然连续 */
function riverLat(lon: number) {
  return 30.246 + 0.0112 * Math.sin((lon - 120.0) * 62) + 0.0034 * Math.cos((lon - 120.0) * 155)
}
function riverHalfW(lon: number) {
  return 0.00085 + 0.00042 * Math.sin((lon - 120.0) * 95 + 1.2)
}
/** 主干路：斜穿全城的曲线 */
function highwayLat(lon: number) {
  return 30.252 + 0.0098 * Math.sin((lon - 120.02) * 40)
}

/** 把经纬度换成瓦片内的像素坐标（原点左上、y 向下） */
function projector(extent: [number, number, number, number]) {
  const w = extent[2] - extent[0]
  const h = extent[3] - extent[1]
  return (lon: number, lat: number): [number, number] => {
    const p = fromLonLat([lon, lat])
    return [((p[0] - extent[0]) / w) * EXT, ((extent[3] - p[1]) / h) * EXT]
  }
}

/** 生成一个瓦片的所有图层 */
function buildTile(z: number, tileCoord: [number, number, number], extent: [number, number, number, number]) {
  const [lonMin, latMin] = toLonLat([extent[0], extent[1]])
  const [lonMax, latMax] = toLonLat([extent[2], extent[3]])

  // 与城市范围不相交的瓦片直接给空瓦片（真实服务里也常这样偷懒）
  if (lonMax < CITY.lon0 || lonMin > CITY.lon1 || latMax < CITY.lat0 || latMin > CITY.lat1) {
    return { layers: [] as MvtLayer[], feats: 0 }
  }

  const px = projector(extent)
  const x0 = Math.max(lonMin, CITY.lon0)
  const x1 = Math.min(lonMax, CITY.lon1)
  const y0 = Math.max(latMin, CITY.lat0)
  const y1 = Math.min(latMax, CITY.lat1)

  const seed = hash(z, tileCoord[1], tileCoord[2])
  const rnd = mulberry(seed)

  /* ---------- 水系：按河流中心线向两侧各偏一个半宽 ---------- */
  const water: MvtFeature[] = []
  const steps = 26
  const north: Array<[number, number]> = []
  const south: Array<[number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const lon = x0 + ((x1 - x0) * i) / steps
    const c = riverLat(lon)
    const hw = riverHalfW(lon)
    north.push(px(lon, c + hw))
    south.push(px(lon, c - hw))
  }
  water.push({
    id: 1,
    geometry: { type: 3, rings: [north.concat(south.reverse())] },
    tags: { kind: 'river', name: '运河' },
  })

  /* ---------- 道路：按全球统一的经纬网间距铺，跨瓦片没有断头 ---------- */
  const roads: MvtFeature[] = []
  // 每放大一级，间距减半 —— 这就是矢量瓦片「按级 LOD」的效果
  const stepLon = 360 / Math.pow(2, z + 4)
  const stepLat = stepLon * Math.cos((((CITY.lat0 + CITY.lat1) / 2) * Math.PI) / 180)

  for (let k = Math.ceil(lonMin / stepLon); k * stepLon <= lonMax; k++) {
    const lon = k * stepLon
    if (lon < x0 || lon > x1) continue
    roads.push({
      id: 1000 + (k & 0x3fff),
      geometry: { type: 2, coords: [px(lon, y0), px(lon, y1)] },
      tags: { class: Math.abs(k) % 4 === 0 ? 'primary' : 'minor' },
    })
  }
  for (let k = Math.ceil(latMin / stepLat); k * stepLat <= latMax; k++) {
    const lat = k * stepLat
    if (lat < y0 || lat > y1) continue
    roads.push({
      id: 2000 + (k & 0x3fff),
      geometry: { type: 2, coords: [px(x0, lat), px(x1, lat)] },
      tags: { class: Math.abs(k) % 4 === 0 ? 'primary' : 'minor' },
    })
  }

  // 主干路：横向贯穿的曲线
  const hw: Array<[number, number]> = []
  for (let i = 0; i <= 24; i++) {
    const lon = x0 + ((x1 - x0) * i) / 24
    hw.push(px(lon, highwayLat(lon)))
  }
  roads.push({ id: 9001, geometry: { type: 2, coords: hw }, tags: { class: 'highway' } })

  /* ---------- POI：密度随级别增长，位置按瓦片种子随机 ---------- */
  const pois: MvtFeature[] = []
  const names = ['轨道交通站', '商业综合体', '社区医院', '中小学校', '绿地公园', '公共停车场']
  const kinds = ['transit', 'shop', 'hospital', 'school', 'park', 'parking']
  const poiCount = Math.min(12, Math.max(4, Math.round(2 * Math.pow(2, z - 12))))
  for (let i = 0; i < poiCount; i++) {
    const lon = x0 + rnd() * (x1 - x0)
    const lat = y0 + rnd() * (y1 - y0)
    const k = Math.floor(rnd() * names.length)
    pois.push({
      id: seed % 5000 + i + 1,
      geometry: { type: 1, coords: px(lon, lat) },
      tags: { kind: kinds[k], name: `${names[k]}${i + 1}`, score: Math.round(rnd() * 100) },
    })
  }

  /* ---------- 建筑：只有高倍才出，按全球网格生成，跨瓦片能接上 ---------- */
  const builds: MvtFeature[] = []
  if (z >= 15) {
    const cell = stepLon * 0.55
    const cellLat = cell * Math.cos((((CITY.lat0 + CITY.lat1) / 2) * Math.PI) / 180)
    for (let gi = Math.ceil(x0 / cell); gi * cell <= x1; gi++) {
      for (let gj = Math.ceil(y0 / cellLat); gj * cellLat <= y1; gj++) {
        const r = mulberry(hash(z, gi, gj))
        // 约 18% 的格子空着，当成公园/空地，城市才不像电路板
        if (r() < 0.18) continue
        const cx = gi * cell + (r() - 0.5) * cell * 0.5
        const cy = gj * cellLat + (r() - 0.5) * cellLat * 0.5
        const w = cell * (0.19 + r() * 0.19)
        const h = cellLat * (0.19 + r() * 0.19)
        // 与瓦片求交后再裁到瓦片内，跨界的楼不会缺一块
        if (cx + w < x0 || cx - w > x1 || cy + h < y0 || cy - h > y1) continue
        const bx0 = Math.max(cx - w, x0)
        const bx1 = Math.min(cx + w, x1)
        const by0 = Math.max(cy - h, y0)
        const by1 = Math.min(cy + h, y1)
        const height = Math.round(6 + r() ** 2 * 54)
        builds.push({
          id: 500000 + (gi & 0x3ff) * 1024 + (gj & 0x3ff),
          geometry: {
            type: 3,
            // y 向下的坐标系里，左上 → 右上 → 右下 → 左下 才是顺时针
            rings: [[px(bx0, by1), px(bx1, by1), px(bx1, by0), px(bx0, by0)]],
          },
          tags: { h: height },
        })
      }
    }
  }

  const layers: MvtLayer[] = []
  if (water.length) layers.push({ name: 'water', features: water, extent: EXT })
  if (roads.length) layers.push({ name: 'road', features: roads, extent: EXT })
  if (builds.length) layers.push({ name: 'building', features: builds, extent: EXT })
  if (pois.length) layers.push({ name: 'poi', features: pois, extent: EXT })

  return { layers, feats: water.length + roads.length + builds.length + pois.length }
}

/* ------------------------------------------------------------------ *
 * 样式：按图层 + 分类查表，避免每个要素都 new 一堆 Style
 * ------------------------------------------------------------------ */
const styleCache = new Map<string, Style[]>()
let labelZoom = HOME_ZOOM

const POI_COLOR: Record<string, string> = {
  transit: '#4f9dff',
  shop: '#ffb24d',
  hospital: '#ff6b6b',
  school: '#8b7bff',
  park: '#46d39a',
  parking: '#9aa8b8',
}

function buildStyle(layer: string, cls: string): Style[] {
  if (layer === 'water') {
    return [
      new Style({
        fill: new Fill({ color: 'rgba(38,104,178,0.5)' }),
        stroke: new Stroke({ color: 'rgba(120,190,255,0.8)', width: 1.1 }),
      }),
    ]
  }
  if (layer === 'road') {
    const conf: Record<string, { c: string; w: number }> = {
      minor: { c: '#47566b', w: 1.4 },
      primary: { c: '#6d7f96', w: 2.8 },
      highway: { c: '#f0b45a', w: 3.4 },
    }
    const s = conf[cls] ?? conf.minor
    return [new Style({ stroke: new Stroke({ color: s.c, width: s.w, lineCap: 'round' }) })]
  }
  if (layer === 'building') {
    const palette = ['#232d3a', '#2a3646', '#323f52', '#3c4a5e', '#47576d']
    const idx = Math.min(4, Math.max(0, parseInt(cls, 10) || 0))
    return [
      new Style({
        fill: new Fill({ color: palette[idx] }),
        stroke: new Stroke({ color: 'rgba(120,150,185,0.5)', width: 0.6 }),
      }),
    ]
  }
  // poi
  const color = POI_COLOR[cls] ?? '#4f9dff'
  return [
    new Style({
      image: new CircleStyle({
        radius: 4.2,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: 'rgba(6,10,16,0.9)', width: 1.4 }),
      }),
    }),
  ]
}

function styleOf(feature: FeatureLike): Style[] | void {
  const layer = feature.get('layer') as string
  if (!vis[layer]) return
  let cls: string
  if (layer === 'road') cls = String(feature.get('class'))
  else if (layer === 'building') cls = String(Math.floor(Number(feature.get('h') ?? 10) / 15))
  else if (layer === 'poi') cls = String(feature.get('kind'))
  else cls = 'water'

  const key = `${layer}|${cls}`
  let cached = styleCache.get(key)
  if (!cached) {
    cached = buildStyle(layer, cls)
    styleCache.set(key, cached)
  }

  // 标注要带要素自己的名字，不能跟着样式缓存共用；declutter 也要求 text 有值，
  // 只给 Text 而不给文本时 OL 不会兜底去读要素属性
  if (layer === 'poi' && stats.z >= 15) {
    const named = cached.map((st) => {
      const copy = st.clone()
      copy.setText(
        new Text({
          text: String(feature.get('name') ?? ''),
          font: '11px sans-serif',
          offsetY: -11,
          fill: new Fill({ color: '#e8f1fb' }),
          stroke: new Stroke({ color: 'rgba(4,8,14,0.85)', width: 2.6 }),
        }),
      )
      return copy
    })
    return named
  }
  return cached
}

/* ------------------------------------------------------------------ *
 * 数据源：tileLoadFunction 里现编现解，不经过网络
 * ------------------------------------------------------------------ */
// ol 9.2.4 的 ol/source/VectorTile.d.ts 里 default 导出错写成了 tile 类，
// 类型上拿不到 getTileGrid()/refresh()，这里按运行时实际形状收敛成最小接口
interface VtSource {
  refresh(): void
  getTileGrid(): { getTileCoordExtent(coord: number[]): [number, number, number, number] } | null
}
const VectorTileSource = VectorTileSourceImpl as unknown as new (opts: Record<string, unknown>) => VtSource

const format = new MVT({ layerName: 'layer' })
let source: VtSource | null = null
let layer: VectorTileLayer<RenderFeature> | null = null

function makeSource() {
  const src: VtSource = new VectorTileSource({
    projection: 'EPSG:3857',
    tileUrlFunction: (coord: number[]) => `mvt:${coord[0]}/${coord[1]}/${coord[2]}`,
    tileLoadFunction: (tile: unknown, url: string) => {
      const vt = tile as VectorTile
      const coord = vt.tileCoord
      const extent = src.getTileGrid()!.getTileCoordExtent(coord)
      const [, , ty] = url.split(':')[1].split('/').map(Number)
      const built = buildTile(coord[0], [coord[0], coord[1], ty], extent)
      const bytes = encodeMvt(built.layers)
      stats.tiles++
      stats.feats += built.feats
      stats.bytes += bytes.byteLength
      if (paused.value) {
        vt.setFeatures([])
        return
      }
      // 交给官方的 MVT 解码器：字节流 → 要素，extent 决定 0..4096 映射到哪块地面。
      // 只能传 featureProjection：dataProjection 会被 setExtent/setWorldExtent 改成
      // 瓦片像素范围，连视图的 EPSG:3857 投影一起污染掉，之后瓦片坐标全算歪
      const features = format.readFeatures(bytes.buffer as ArrayBuffer, {
        extent,
        featureProjection: 'EPSG:3857',
      })
      vt.setFeatures(features)
    },
  })
  return src
}

/** 图层开关 / 缩放变化后要让渲染缓存失效 */
function invalidate() {
  styleCache.clear()
  layer?.changed()
}

const layerList = computed(() => [
  { id: 'water', label: '水系 water', n: 'polygon' },
  { id: 'road', label: '道路 road', n: 'line' },
  { id: 'building', label: '建筑 building', n: 'z≥15' },
  { id: 'poi', label: '设施 poi', n: 'point' },
])

onMounted(() => {
  source = makeSource()
  layer = new VectorTileLayer<RenderFeature>({
    // 源类型的 d.ts 是坏的（见上），类型上这里只能按 never 收口，运行时就是正常 source
    source: source as never,
    declutter: true,
    style: styleOf,
    updateWhileAnimating: true,
    updateWhileInteracting: true,
  })

  map = new OlMap({
    target: container.value,
    layers: [layer],
    view: new View({ center: CENTER, zoom: HOME_ZOOM, minZoom: 9, maxZoom: 18 }),
    controls: [],
  })

  map.getView().on('change:resolution', () => {
    const z = Math.round(map!.getView().getZoom() ?? HOME_ZOOM)
    if (z !== stats.z) {
      stats.z = z
      invalidate()
    }
  })

  map.on('click', (evt) => {
    const hit = map!.forEachFeatureAtPixel(
      evt.pixel,
      (f) => f,
      { hitTolerance: 4, layerFilter: (l) => l === layer },
    )
    if (!hit) {
      picked.value = []
      pickedLayer.value = ''
      return
    }
    pickedLayer.value = String(hit.get('layer') ?? '')
    // RenderFeature 没有 getKeys()，属性表要从 getProperties() 拿
    const props = hit.getProperties() as Record<string, unknown>
    picked.value = Object.keys(props)
      .filter((k) => k !== 'geometry')
      .map((k) => [k, String(props[k])] as [string, string])
  })
})

const tileKb = computed(() => {
  const n = stats.tiles || 1
  return (stats.bytes / 1024 / n).toFixed(1)
})
const totalKb = computed(() => (stats.bytes / 1024).toFixed(1))

function toggle(id: string) {
  vis[id] = !vis[id]
  invalidate()
}

function reload() {
  stats.tiles = 0
  stats.feats = 0
  stats.bytes = 0
  styleCache.clear()
  source?.refresh()
}
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>

    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <div class="head-text">
          <div class="name">MVT 矢量瓦片 · 自建编码器</div>
          <div class="url">protobuf → VectorTileSource → ol/format/MVT</div>
        </div>
      </div>

      <div class="rows">
        <button v-for="l in layerList" :key="l.id" class="row" :class="{ off: !vis[l.id] }" @click="toggle(l.id)">
          <span class="box" :class="{ on: vis[l.id] }"></span>
          <span class="rl">{{ l.label }}</span>
          <span class="rn">{{ l.n }}</span>
        </button>
      </div>

      <div class="stats">
        <div class="st"><b>z {{ stats.z }}</b><span>缩放级</span></div>
        <div class="st"><b>{{ stats.tiles }}</b><span>瓦片·累计</span></div>
        <div class="st"><b>{{ stats.feats }}</b><span>要素·累计</span></div>
        <div class="st"><b>{{ tileKb }}</b><span>KB/片</span></div>
      </div>

      <div class="bar">
        <button class="mini" @click="reload">重新请求</button>
        <button class="mini" :class="{ on: paused }" @click="paused = !paused; invalidate()">
          {{ paused ? '启用数据' : '暂停数据' }}
        </button>
      </div>

      <div v-if="picked.length" class="pick">
        <div class="pick-head">拾取 · {{ pickedLayer }}</div>
        <div v-for="[k, v] in picked" :key="k" class="kv">
          <span>{{ k }}</span><b>{{ v }}</b>
        </div>
      </div>
      <div v-else class="hint">
        滚轮放大到 <b>z15</b> 会出现建筑面；<b>z15</b> 起 POI 带标注。
        全部瓦片由页面里的编码器现场生成，共 {{ totalKb }} KB。
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
  background: #0d1420;
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
  background: rgba(14, 20, 29, 0.92);
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
  background: #46d39a;
  box-shadow: 0 0 8px #46d39a;
  flex: none;
}
.head-text {
  min-width: 0;
}
.name {
  font-size: 12.5px;
  font-weight: 600;
  color: #eaf2fb;
}
.url {
  font-size: 10px;
  color: #7d8fa3;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rows {
  margin-top: 9px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.03);
  color: #c6d5e5;
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
}
.row:hover {
  border-color: rgba(79, 157, 255, 0.4);
}
.row.off {
  opacity: 0.42;
}
.box {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  border: 1px solid rgba(120, 145, 170, 0.7);
  flex: none;
}
.box.on {
  background: #2f6fd0;
  border-color: #2f6fd0;
  box-shadow: inset 0 0 0 2px rgba(14, 20, 29, 0.85);
}
.rl {
  flex: 1;
}
.rn {
  font-size: 9.5px;
  color: #6f8194;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-top: 10px;
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
.bar {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}
.mini {
  padding: 4px 9px;
  border-radius: 5px;
  border: 1px solid rgba(90, 112, 138, 0.55);
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
.mini.on {
  background: #2f6fd0;
  border-color: #2f6fd0;
  color: #fff;
}
.pick {
  margin-top: 9px;
  padding: 7px 8px;
  border-radius: 7px;
  background: rgba(79, 157, 255, 0.1);
  border: 1px solid rgba(79, 157, 255, 0.32);
}
.pick-head {
  font-size: 10.5px;
  color: #7bbcff;
  margin-bottom: 4px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 1.65;
}
.kv span {
  color: #8296aa;
}
.kv b {
  color: #eaf2fb;
  font-weight: 500;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
