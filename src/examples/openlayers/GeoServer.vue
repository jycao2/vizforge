<script setup lang="ts">
/**
 * GeoServer 图层服务
 * ===========================================================================
 * 演示「GIS 服务」这一段链路：服务能力文档 → 图层目录 → WMS 出图 → CQL 过滤
 * → GetFeatureInfo 点查 → WFS 要素下载。
 *
 * 服务端跑在浏览器里（见 shared/ogc.ts），请求参数与 GeoServer 完全一致：
 *   /geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=city:grid
 *                &bbox=...&width=256&height=256&crs=EPSG:3857&cql_filter=value>60
 * 换成真实 GeoServer 时，只把 host 改掉，前端代码不用动 —— 面板里会把这条
 * 标准 URL 直接列出来，方便复制到 QGIS / curl 里对拍。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import TileImage from 'ol/source/TileImage'
import type ImageTile from 'ol/ImageTile'
import { createXYZ } from 'ol/tilegrid'
import { fromLonLat, transformExtent } from 'ol/proj'
import type { MapBrowserEvent } from 'ol'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import {
  EXTENT,
  SERVICE_TITLE,
  WORLD,
  getCapabilities,
  getFeatureInfo,
  buildUrl,
  getFeature,
  getMap,
  getStats,
  listLayers,
  onRequest,
  resetStats,
  type FeatureInfoResult,
  type StyleSpec,
} from '@/examples/shared/ogc'

/* ------------------------------ 服务目录 ------------------------------ */

interface LayerRow {
  name: string
  title: string
  type: string
  crs: string
  note: string
  count: number
  color: string
  fields: Array<{ name: string; type: string; note?: string }>
  style: StyleSpec
  on: boolean
}

/** 绘制顺序：数组靠后的画在上层 */
const rows = ref<LayerRow[]>(
  listLayers().map((l) => ({
    name: l.name,
    title: l.title,
    type: l.type,
    crs: l.crs,
    note: l.note,
    count: l.count,
    color: l.style.ramp ? `linear-gradient(90deg, ${l.style.ramp.stops.map((s) => s[1]).join(',')})` : (l.style.fill ?? l.style.stroke ?? '#7fd0ff'),
    fields: l.fields,
    style: l.style,
    // 默认开：网格 + 路网 + 水系。建成区与 1.2 万站点默认关，
    // 全开会把画面糊成一片；它们更适合单独打开看，或用于点查演示。
    on: l.name === 'city:grid' || l.name === 'city:roads' || l.name === 'city:rivers',
  })),
)

const selected = ref<string>('city:grid')
const selectedRow = computed(() => rows.value.find((r) => r.name === selected.value) ?? rows.value[0])

/** 生效图层（按 rows 顺序 = 绘制顺序） */
function activeNames(): string[] {
  return rows.value.filter((r) => r.on).map((r) => r.name)
}

/* ------------------------------ 过滤与样式 ------------------------------ */

/** 每个图层独立保存 CQL，切图层时可以分别调 */
const cqlMap = ref<Record<string, string>>({})
const cqlDraft = ref('')
const cqlError = ref('')

const PRESETS = ['value > 60', "level = 'high'", "value > 80 AND level = 'high'", 'pm25 > 75']

function applyCql(expr?: string) {
  const text = (expr ?? cqlDraft.value).trim()
  cqlDraft.value = text
  cqlError.value = ''
  // 粗校验：括号配对 + 条件里有比较符
  if (text) {
    const open = (text.match(/\(/g) ?? []).length
    const close = (text.match(/\)/g) ?? []).length
    if (open !== close) {
      cqlError.value = '括号不配对'
      return
    }
    // 必须形如 `field op value` 或 `field LIKE 'x%'`：
    // 只写 `value >` 时 parseCql 会退化成"全通过"，静默失效比报错更难查
    const ok = /LIKE\s+\S+/i.test(text) || /[A-Za-z_][\w.]*\s*(>=|<=|!=|<>|=|>|<)\s*[^\s()]+/.test(text)
    if (!ok) {
      cqlError.value = '条件不完整，例如 value > 60'
      return
    }
  }
  cqlMap.value = { ...cqlMap.value, [selected.value]: text }
  invalidate()
}

function pickRow(row: LayerRow) {
  selected.value = row.name
  cqlDraft.value = cqlMap.value[row.name] ?? ''
  cqlError.value = ''
}

function toggleRow(row: LayerRow) {
  row.on = !row.on
  invalidate()
}

/** 图层不透明度（演示 SLD 之外的 WMS 参数） */
const opacity = ref(0.92)

/* ------------------------------ 地图与瓦片 ------------------------------ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: Map | null = null
let dataLayer: TileLayer<TileImage> | null = null
let source: TileImage | null = null

const CENTER = fromLonLat([(EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2])
const DATA_EXTENT = transformExtent([EXTENT.w, EXTENT.s, EXTENT.e, EXTENT.n], 'EPSG:4326', 'EPSG:3857')
const { zoomBy, toggleFullscreen } = useOlView(() => map, CENTER, 7.2)

/** 复位：fit 到研究区，左侧给目录面板留出宽度，避免数据被压在面板下面 */
function reset() {
  const narrow = (wrapRef.value?.clientWidth ?? 1200) < 900
  map?.getView().fit(DATA_EXTENT, {
    // 左侧留出目录面板宽度；右/下只留一点边 —— 指标面板是半透明浮层，压住地图一角无妨
    padding: narrow ? [24, 24, 24, 24] : [26, 34, 34, 316],
    duration: 320,
  })
}
const { current: currentBasemap, create, apply } = useOlBasemap('terrain')

/**
 * 瓦片源：每个瓦片等价于一次 WMS GetMap。
 *
 * 为什么用 TileImage 而不直接 DataTile：DataTile 的 RGBA 缓冲只有 WebGL 渲染器认，
 * 挂到普通 TileLayer 上会走 canvas 渲染器并抛 `tile.getImage is not a function`。
 * 这里保留标准瓦片生命周期，把本地光栅化结果塞回 <img>，与真实 WMS 的行为一致。
 */
function makeSource(): TileImage {
  const tileGrid = createXYZ({ tileSize: 256, maxZoom: 14 })
  return new TileImage({
    tileGrid,
    transition: 0,
    tileUrlFunction: (coord) => {
      // 返回标准 GeoServer URL：既是调试线索，也让"请求地址"面板有真实内容
      const span = WORLD / Math.pow(2, coord[0])
      const minX = -WORLD / 2 + coord[1] * span
      const maxY = WORLD / 2 - coord[2] * span
      return buildUrl('GetMap', {
        layers: activeNames(),
        bbox: [minX, maxY - span, minX + span, maxY],
        width: 256,
        height: 256,
        cql: cqlMap.value,
      })
    },
    tileLoadFunction: (tile) => {
      const t = tile as ImageTile
      const [z, x, y] = t.tileCoord
      const span = WORLD / Math.pow(2, z)
      const minX = -WORLD / 2 + x * span
      const maxY = WORLD / 2 - y * span
      const { image } = getMap({
        layers: activeNames(),
        bbox: [minX, maxY - span, minX + span, maxY],
        width: 256,
        height: 256,
        cql: cqlMap.value,
        opacity: Object.fromEntries(rows.value.map((r) => [r.name, opacity.value])),
        tile: [z, x, y],
      })
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      ;(t.getImage() as HTMLImageElement).src = canvas.toDataURL('image/png')
    },
  })
}

/** 图层/过滤/透明度变化后重新出图 */
function invalidate() {
  source?.refresh()
}

/* ------------------------------ 统计与日志 ------------------------------ */

const stats = ref({ requests: 0, tiles: 0, avgMs: 0, maxMs: 0, features: 0 })
const logs = ref<Array<{ op: string; detail: string; ms: number; features: number }>>([])
const lastUrl = ref('')

let unsubscribe: (() => void) | null = null
let timer = 0

function pullStats() {
  const s = getStats()
  stats.value = { requests: s.requests, tiles: s.tiles, avgMs: s.avgMs, maxMs: s.maxMs, features: s.features }
  if (s.last) lastUrl.value = s.last.url
}

/** 重算：清统计 + 让所有瓦片重新请求 */
function reload() {
  resetStats()
  logs.value = []
  invalidate()
}

/* --------------------------- GetFeatureInfo --------------------------- */

const info = ref<FeatureInfoResult | null>(null)
const infoPos = ref({ x: 0, y: 0 })
/** 点查卡片跟随鼠标位置，但贴右边时要往回收，避免出画 */
const infoStyle = computed(() => {
  const w = wrapRef.value?.clientWidth ?? 1200
  return {
    left: `${Math.min(infoPos.value.x + 16, w - 240)}px`,
    top: `${Math.max(70, infoPos.value.y - 40)}px`,
  }
})

function onMapClick(evt: MapBrowserEvent<MouseEvent>) {
  if (!map) return
  const size = map.getSize()
  if (!size) return
  const extent = map.getView().calculateExtent(size)
  const r = getFeatureInfo({
    layers: activeNames(),
    bbox: [extent[0], extent[1], extent[2], extent[3]],
    width: size[0],
    height: size[1],
    cql: cqlMap.value,
    i: evt.pixel[0],
    j: evt.pixel[1],
  })
  info.value = r.hits.length ? r : null
  infoPos.value = { x: evt.pixel[0], y: evt.pixel[1] }
}

/* ----------------------------- WFS 导出 ----------------------------- */

const wfsMsg = ref('')
const wfsBusy = ref(false)

/**
 * WFS GetFeature → GeoJSON 下载。
 * 与 GeoServer 的 `request=GetFeature&outputFormat=application/json` 等价，
 * 只是响应在本地生成后直接落盘（真实服务是一个 HTTP 下载）。
 */
function exportGeoJson() {
  const name = selected.value
  wfsBusy.value = true
  try {
    const res = getFeature(name, { cql: cqlMap.value[name] ?? '' })
    const blob = new Blob([JSON.stringify(res, null, 0)], { type: 'application/geo+json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(':', '_')}.geojson`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    wfsMsg.value = `已导出 ${res.totalFeatures} 个要素 · ${res.ms.toFixed(1)}ms`
  } catch (e) {
    wfsMsg.value = '导出失败：' + String(e)
  } finally {
    wfsBusy.value = false
  }
}

/* --------------------------- 能力文档弹层 --------------------------- */

const capsOpen = ref(false)
const capsXml = shallowRef('')

function openCaps() {
  capsXml.value = getCapabilities()
  capsOpen.value = true
}

/* ------------------------------ 复制 URL ------------------------------ */

const copied = ref(false)
async function copyUrl() {
  if (!lastUrl.value) return
  try {
    await navigator.clipboard.writeText(lastUrl.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch {
    copied.value = false
  }
}

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(() => {
  const base = create()
  source = makeSource()
  dataLayer = new TileLayer({ source, opacity: opacity.value })

  map = new Map({
    target: container.value!,
    layers: [base, dataLayer],
    view: new View({ center: CENTER, zoom: 7.2, minZoom: 5, maxZoom: 13 }),
  })
  reset()
  map.on('singleclick', onMapClick)

  unsubscribe = onRequest((l) => {
    if (l.op === 'GetMap') {
      // GetMap 太多，只留最近几条，避免列表被瓦片刷屏
      logs.value = [
        { op: l.op, detail: `${l.layers.join(',')} · z${l.z ?? ''}`, ms: l.ms, features: l.features },
        ...logs.value.filter((x) => x.op !== 'GetMap'),
      ].slice(0, 6)
    } else {
      logs.value = [
        { op: l.op, detail: l.layers.join(','), ms: l.ms, features: l.features },
        ...logs.value,
      ].slice(0, 6)
    }
  })
  timer = window.setInterval(pullStats, 320)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  unsubscribe?.()
  map?.setTarget(undefined)
  map = null
  source = null
  dataLayer = null
})

/* ------------------------------ 展示辅助 ------------------------------ */

const TYPE_LABEL: Record<string, string> = { Polygon: '面', LineString: '线', Point: '点' }

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n)
}
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

    <!-- 左：服务目录 -->
    <div class="panel catalog">
      <div class="svc">
        <span class="dot"></span>
        <div class="svc-text">
          <div class="svc-name">{{ SERVICE_TITLE }}</div>
          <div class="svc-url">/geoserver/wms · 内置实例 · 离线可用</div>
        </div>
        <button class="mini" @click="openCaps">能力文档</button>
      </div>

      <div class="ws">
        <span class="ws-key">工作区</span>
        <span class="ws-name">city</span>
        <span class="ws-meta">{{ rows.length }} 图层 / {{ fmt(rows.reduce((a, b) => a + b.count, 0)) }} 要素</span>
      </div>

      <ul class="layers">
        <li
          v-for="row in [...rows].reverse()"
          :key="row.name"
          class="layer"
          :class="{ active: row.name === selected }"
          @click="pickRow(row)"
        >
          <button
            class="sw"
            :class="{ off: !row.on }"
            :style="{ background: row.color }"
            :title="row.on ? '隐藏图层' : '显示图层'"
            @click.stop="toggleRow(row)"
          />
          <div class="layer-main">
            <div class="layer-title">
              <span class="q">{{ TYPE_LABEL[row.type] }}</span>
              {{ row.title }}
            </div>
            <div class="layer-name">{{ row.name }} · {{ fmt(row.count) }}</div>
          </div>
          <span class="tick" v-if="row.on">◉</span>
        </li>
      </ul>

      <div class="filter">
        <div class="filter-head">
          <span>CQL_FILTER</span>
          <span class="tiny">{{ selectedRow?.name }}</span>
        </div>
        <div class="cql-row">
          <input
            v-model="cqlDraft"
            class="cql"
            :class="{ bad: cqlError }"
            placeholder="value > 60"
            @keydown.enter="applyCql()"
          />
          <button class="mini solid" @click="applyCql()">应用</button>
        </div>
        <div v-if="cqlError" class="err">{{ cqlError }}</div>
        <div class="presets">
          <button
            v-for="p in PRESETS"
            :key="p"
            class="preset"
            @click="applyCql(p)"
          >
            {{ p }}
          </button>
          <button class="preset clear" @click="applyCql('')">清空</button>
        </div>
        <div class="wfs">
          <button class="mini" :disabled="wfsBusy" @click="exportGeoJson">
            WFS · 导出 GeoJSON
          </button>
          <span class="wfs-msg">{{ wfsMsg }}</span>
        </div>
      </div>
    </div>

    <!-- 右上：服务指标 -->
    <div class="panel metrics">
      <div class="m-head">
        <span>服务指标</span>
        <button class="mini" @click="reload">重载</button>
      </div>
      <div class="grid">
        <div class="cell"><b>{{ stats.tiles }}</b><span>GetMap 瓦片</span></div>
        <div class="cell"><b>{{ stats.avgMs.toFixed(1) }}</b><span>平均耗时 ms</span></div>
        <div class="cell"><b>{{ stats.maxMs.toFixed(1) }}</b><span>峰值 ms</span></div>
        <div class="cell"><b>{{ fmt(stats.features) }}</b><span>累计要素</span></div>
      </div>
      <div class="op">
        <span>图层不透明度</span>
        <input v-model.number="opacity" type="range" min="0.2" max="1" step="0.02" @input="invalidate" />
        <b>{{ Math.round(opacity * 100) }}%</b>
      </div>
      <div class="log">
        <div v-for="(l, i) in logs.slice(0, 4)" :key="i" class="log-row">
          <span class="op-tag">{{ l.op }}</span>
          <span class="log-detail">{{ l.detail }}</span>
          <span class="log-ms">{{ l.ms.toFixed(1) }}ms</span>
        </div>
        <div v-if="!logs.length" class="log-empty">等待瓦片请求…</div>
      </div>
      <div class="url">
        <div class="url-head">
          <span>最近请求 URL</span>
          <button class="mini" @click="copyUrl">{{ copied ? '已复制' : '复制' }}</button>
        </div>
        <code>{{ lastUrl || '—' }}</code>
        <div class="url-tip">换成真实 GeoServer 时，只需把 host 替换成你的服务地址。</div>
      </div>
    </div>

    <!-- 点击查询结果 -->
    <div v-if="info" class="panel info" :style="infoStyle">
      <div class="info-head">
        <span>GetFeatureInfo · {{ info.ms.toFixed(1) }}ms</span>
        <button class="mini" @click="info = null">×</button>
      </div>
      <div v-for="(h, i) in info.hits" :key="i" class="hit">
        <div class="hit-layer">{{ h.layer }} #{{ h.id }}</div>
        <div v-for="(v, k) in h.properties" :key="k" class="kv">
          <span>{{ k }}</span><b>{{ v }}</b>
        </div>
      </div>
    </div>

    <!-- 能力文档 -->
    <div v-if="capsOpen" class="caps-mask" @click.self="capsOpen = false">
      <div class="caps">
        <div class="caps-head">
          <span>GetCapabilities · WMS 1.3.0</span>
          <button class="mini" @click="capsOpen = false">关闭</button>
        </div>
        <pre>{{ capsXml }}</pre>
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

/* ---------------- 服务目录 ---------------- */
.catalog {
  left: 14px;
  top: 14px;
  width: 288px;
  padding: 11px 12px 12px;
}
.svc {
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
.svc-text {
  flex: 1;
  min-width: 0;
}
.svc-name {
  font-size: 12.5px;
  font-weight: 600;
  color: #eaf2fb;
}
.svc-url {
  font-size: 10.5px;
  color: #7d8fa3;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini {
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid rgba(90, 112, 138, 0.55);
  background: transparent;
  color: #a9bccf;
  font-size: 10.5px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex: none;
}
.mini:hover {
  border-color: #4f9dff;
  color: #7bbcff;
}
.mini.solid {
  background: #2f6fd0;
  border-color: #2f6fd0;
  color: #fff;
}

.ws {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 9px 0 7px;
}
.ws-key {
  font-size: 10px;
  color: #6c7f93;
  letter-spacing: 0.08em;
}
.ws-name {
  font-size: 12px;
  color: #7bbcff;
  font-weight: 600;
}
.ws-meta {
  margin-left: auto;
  font-size: 10px;
  color: #6c7f93;
}

.layers {
  list-style: none;
  margin: 0;
  padding: 0;
}
.layer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  border-radius: 7px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.14s ease;
}
.layer:hover {
  background: rgba(79, 157, 255, 0.08);
}
.layer.active {
  background: rgba(79, 157, 255, 0.14);
  border-color: rgba(79, 157, 255, 0.45);
}
.sw {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  cursor: pointer;
  flex: none;
  padding: 0;
  transition: opacity 0.15s ease;
}
.sw.off {
  opacity: 0.22;
}
.layer-main {
  flex: 1;
  min-width: 0;
}
.layer-title {
  font-size: 11.5px;
  color: #dfe9f4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.q {
  display: inline-block;
  padding: 0 3px;
  margin-right: 4px;
  border-radius: 3px;
  background: rgba(120, 160, 200, 0.18);
  color: #9db6cd;
  font-size: 9.5px;
}
.layer-name {
  font-size: 10px;
  color: #6f8296;
  margin-top: 1px;
}
.tick {
  font-size: 9px;
  color: #4f9dff;
}

.filter {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid rgba(90, 112, 138, 0.25);
}
.filter-head {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #7d8fa3;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}
.tiny {
  color: #5d7186;
  font-size: 9.5px;
}
.cql-row {
  display: flex;
  gap: 6px;
}
.cql {
  flex: 1;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 5px;
  border: 1px solid rgba(90, 112, 138, 0.5);
  background: rgba(8, 13, 20, 0.7);
  color: #cfe0f2;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 11px;
  outline: none;
}
.cql:focus {
  border-color: #4f9dff;
}
.cql.bad {
  border-color: #e0614b;
}
.err {
  margin-top: 4px;
  font-size: 10px;
  color: #ef8368;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.preset {
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(90, 112, 138, 0.4);
  background: transparent;
  color: #8fa4b9;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 9.5px;
  cursor: pointer;
}
.preset:hover {
  border-color: #4f9dff;
  color: #7bbcff;
}
.preset.clear {
  color: #a1736b;
}
.wfs {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
}
.wfs-msg {
  font-size: 9.5px;
  color: #7ee2b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------------- 指标 ---------------- */
.metrics {
  right: 14px;
  bottom: 14px;
  width: 262px;
  padding: 11px 12px;
}
.m-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11.5px;
  color: #c8d6e5;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.25);
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin: 9px 0;
}
.cell {
  padding: 6px 8px;
  border-radius: 7px;
  background: rgba(28, 38, 52, 0.75);
  border: 1px solid rgba(90, 112, 138, 0.22);
}
.cell b {
  display: block;
  font-size: 15px;
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.cell span {
  font-size: 9.5px;
  color: #7d8fa3;
}
.op {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10.5px;
  color: #8fa4b9;
}
.op input {
  flex: 1;
  accent-color: #4f9dff;
  min-width: 0;
}
.op b {
  color: #cfe0f2;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.log {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(90, 112, 138, 0.25);
  min-height: 58px;
}
.log-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  padding: 2px 0;
  color: #8fa4b9;
}
.op-tag {
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(79, 157, 255, 0.16);
  color: #7bbcff;
  font-size: 9px;
  flex: none;
}
.log-detail {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: ui-monospace, Menlo, monospace;
}
.log-ms {
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
}
.log-empty {
  font-size: 10px;
  color: #5d7186;
  padding: 6px 0;
}

.url {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(90, 112, 138, 0.25);
}
.url-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  color: #7d8fa3;
  margin-bottom: 5px;
}
.url code {
  display: block;
  max-height: 46px;
  overflow: hidden;
  padding: 5px 6px;
  border-radius: 5px;
  background: rgba(8, 13, 20, 0.75);
  color: #86a2bb;
  font-size: 9px;
  line-height: 1.45;
  word-break: break-all;
}
.url-tip {
  margin-top: 4px;
  font-size: 9.5px;
  color: #5d7186;
}

/* ---------------- 点查结果 ---------------- */
.info {
  width: 218px;
  padding: 9px 10px;
  max-height: 320px;
  overflow: auto;
}
.info-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10.5px;
  color: #9db6cd;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.25);
}
.hit {
  padding: 6px 0 2px;
}
.hit-layer {
  font-size: 10px;
  color: #7bbcff;
  margin-bottom: 3px;
  font-family: ui-monospace, Menlo, monospace;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: #8fa4b9;
  padding: 1px 0;
}
.kv b {
  color: #dfe9f4;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

/* ---------------- 能力文档 ---------------- */
.caps-mask {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(6, 10, 16, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
}
.caps {
  width: 640px;
  max-width: 88vw;
  max-height: 74vh;
  display: flex;
  flex-direction: column;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.98);
  border: 1px solid rgba(90, 112, 138, 0.45);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}
.caps-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 11px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.3);
  font-size: 11.5px;
  color: #c8d6e5;
}
.caps pre {
  margin: 0;
  padding: 11px 13px;
  overflow: auto;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10px;
  line-height: 1.55;
  color: #8fb0cc;
}
</style>
