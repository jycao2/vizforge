<script setup lang="ts">
/**
 * WMTS 切片服务
 * ===========================================================================
 * WMS 每次请求都现场渲染，WMTS 是「预切 + 缓存」——同一张瓦片第二次要时直接给。
 * 这个示例把两者的差别做成可测量的：
 *
 *   切到 WMTS 模式 → 平移再回来，绿色（命中，亚毫秒）
 *   切到 WMS 模式 → 同样平移再回来，橙色（每次重渲染 2~8ms）
 *
 * 底部那排小柱子就是最近 40 次瓦片请求的耗时，颜色区分命中/未命中。
 * 图层故意叠了四层（网格 + 建成区 + 路网 + 水系），拉大两种模式的耗时差距。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import TileImage from 'ol/source/TileImage'
import type ImageTile from 'ol/ImageTile'
import { createXYZ } from 'ol/tilegrid'
import { transformExtent } from 'ol/proj'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import {
  EXTENT,
  WORLD,
  clearTileCache,
  getMap,
  getTileCacheStats,
  listLayers,
  wmtsTile,
  type TileCacheStats,
} from '@/examples/shared/ogc'

/* ------------------------------ 图层 ------------------------------ */

interface LayerRow {
  name: string
  label: string
  count: number
  on: boolean
}

const rows = ref<LayerRow[]>(
  listLayers()
    .filter((l) => ['city:grid', 'city:builtup', 'city:roads', 'city:rivers', 'city:sensors'].includes(l.name))
    .map((l) => ({
      name: l.name,
      label: l.title.split('·').pop()?.trim() ?? l.name,
      count: l.count,
      // 站点 1.1 万点会把渲染耗时拉得很高，默认关掉，需要时再开
      on: l.name !== 'city:sensors',
    })),
)

const active = computed(() => rows.value.filter((r) => r.on).map((r) => r.name))

function toggle(row: LayerRow) {
  if (row.on && active.value.length === 1) return // 至少留一层
  row.on = !row.on
  source?.refresh()
}

/* ------------------------------ 模式 ------------------------------ */

/** wmts = 走切片缓存；wms = 每次实时渲染 */
const mode = ref<'wmts' | 'wms'>('wmts')

function setMode(m: 'wmts' | 'wms') {
  if (mode.value === m) return
  mode.value = m
  samples.value = []
  // 切模式必须刷新瓦片源，否则 OL 会沿用自己缓存里的旧瓦片
  source?.refresh()
}

/* ------------------------------ 采样 ------------------------------ */

interface Sample {
  ms: number
  cached: boolean
}

const samples = ref<Sample[]>([])
const MAX_SAMPLES = 40
/** WMS 直出的累计统计（WMTS 的命中率来自服务层） */
let wmsCount = 0
let wmsTotal = 0
const wmsAvg = ref(0)

function pushSample(ms: number, cached: boolean) {
  samples.value = [...samples.value.slice(-(MAX_SAMPLES - 1)), { ms, cached }]
  if (!cached) {
    wmsCount++
    wmsTotal += ms
    if (mode.value === 'wms') wmsAvg.value = wmsTotal / wmsCount
  }
}

/* ------------------------------ 缓存统计 ------------------------------ */

const cache = ref<TileCacheStats>({ hits: 0, misses: 0, size: 0, hitRate: 0, lastMs: 0, lastCached: false })
let timer = 0

function pullCache() {
  cache.value = getTileCacheStats()
}

function clearCache() {
  clearTileCache()
  samples.value = []
  wmsCount = 0
  wmsTotal = 0
  wmsAvg.value = 0
  source?.refresh()
}

/* ------------------------------ 地图 ------------------------------ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlMap | null = null
let source: TileImage | null = null

const DATA_EXTENT = transformExtent([EXTENT.w, EXTENT.s, EXTENT.e, EXTENT.n], 'EPSG:4326', 'EPSG:3857')
const { zoomBy, toggleFullscreen } = useOlView(() => map, [0, 0], 7)
const { current: currentBasemap, create, apply } = useOlBasemap('terrain')

function reset() {
  const narrow = (wrapRef.value?.clientWidth ?? 1200) < 900
  map?.getView().fit(DATA_EXTENT, { padding: narrow ? [24, 24, 24, 24] : [26, 40, 250, 320], duration: 320 })
}

/** 构造 WMTS GetTile URL（展示用，语义与 GeoServer gwc 一致） */
function tileUrl(z: number, x: number, y: number): string {
  return `/geoserver/gwc/service/wmts?service=WMTS&request=GetTile&version=1.0.0&layer=${active.value.join(
    ',',
  )}&style=default&tilematrixset=EPSG:3857&tilematrix=EPSG:3857:${z}&tilerow=${y}&tilecol=${x}&format=image/png`
}

function makeSource(): TileImage {
  const tileGrid = createXYZ({ tileSize: 256, maxZoom: 14 })
  return new TileImage({
    tileGrid,
    transition: 0,
    tileUrlFunction: (coord) => {
      const u = tileUrl(coord[0], coord[1], coord[2])
      lastUrl.value = u
      return u
    },
    tileLoadFunction: (tile) => {
      const t = tile as ImageTile
      const [z, x, y] = t.tileCoord
      const t0 = performance.now()

      let image: ImageData
      if (mode.value === 'wmts') {
        const r = wmtsTile(active.value, z, x, y)
        image = r.image
        pushSample(r.ms, r.cached)
      } else {
        // WMS 直出：不查缓存，每次现场渲染
        const span = WORLD / Math.pow(2, z)
        const minX = -WORLD / 2 + x * span
        const maxY = WORLD / 2 - y * span
        const r = getMap({
          layers: active.value,
          bbox: [minX, maxY - span, minX + span, maxY],
          width: 256,
          height: 256,
          silent: true,
        })
        image = r.image
        pushSample(performance.now() - t0, false)
      }

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      ;(t.getImage() as HTMLImageElement).src = canvas.toDataURL('image/png')
    },
  })
}

/* ------------------------------ 视图信息 ------------------------------ */

const zoomLevel = ref(7)
/** 命中缓存的耗时常常小于 0.005ms，直接 toFixed 会显示成 0.00，看着像坏了 */
const lastMsText = computed(() => {
  const ms = samples.value[samples.value.length - 1]?.ms
  if (ms == null) return '—'
  return ms < 0.01 ? '<0.01 ms' : `${ms.toFixed(2)} ms`
})
const lastUrl = ref('')

function syncView() {
  if (!map) return
  const z = Math.round(map.getView().getZoom() ?? 0)
  zoomLevel.value = z
}

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(() => {
  const base = create()
  source = makeSource()
  const layer = new TileLayer({ source })

  map = new OlMap({
    target: container.value!,
    layers: [base, layer],
    view: new View({ center: [0, 0], zoom: 7, minZoom: 5, maxZoom: 13 }),
  })
  reset()
  map.on('moveend', syncView)
  syncView()

  timer = window.setInterval(pullCache, 280)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  map?.setTarget(undefined)
  map = null
  source = null
})

/* ------------------------------ 展示辅助 ------------------------------ */

/** 柱子高度：按 8ms 满格归一，超出截断 */
function barHeight(ms: number): string {
  return `${Math.max(6, Math.min(100, (ms / 8) * 100))}%`
}

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

    <!-- 左：服务与图层 -->
    <div class="panel left">
      <div class="svc">
        <span class="dot"></span>
        <div class="svc-text">
          <div class="svc-name">WMTS 1.0.0 · 内置实例</div>
          <div class="svc-url">/geoserver/gwc/service/wmts</div>
        </div>
      </div>

      <div class="kv">
        <span>tilematrixset</span><b>EPSG:3857</b>
      </div>
      <div class="kv">
        <span>tilematrix</span><b>EPSG:3857:{{ zoomLevel }}</b>
      </div>
      <div class="kv">
        <span>tilesize</span><b>256 × 256</b>
      </div>

      <div class="modes">
        <button class="mode" :class="{ on: mode === 'wmts' }" @click="setMode('wmts')">
          <b>WMTS 切片</b><span>命中缓存直接返回</span>
        </button>
        <button class="mode" :class="{ on: mode === 'wms' }" @click="setMode('wms')">
          <b>WMS 直出</b><span>每次现场渲染</span>
        </button>
      </div>

      <div class="layers">
        <button
          v-for="row in rows"
          :key="row.name"
          class="chip"
          :class="{ on: row.on }"
          @click="toggle(row)"
        >
          {{ row.label }}<i>{{ fmt(row.count) }}</i>
        </button>
      </div>

      <div class="acts">
        <button class="mini" @click="clearCache">清空切片缓存</button>
        <button class="mini" @click="reset">复位视图</button>
      </div>
      <div class="tip">平移出去再拖回来，看下方柱子：绿=命中缓存，橙=重新渲染。</div>
    </div>

    <!-- 右下：缓存与耗时 -->
    <div class="panel right">
      <div class="head">
        <span>切片缓存</span>
        <span class="badge" :class="mode">{{ mode === 'wmts' ? 'WMTS' : 'WMS 直出' }}</span>
      </div>

      <div class="big">
        <div class="n">{{ (cache.hitRate * 100).toFixed(0) }}<i>%</i></div>
        <div class="l">命中率</div>
      </div>

      <div class="grid">
        <div class="c"><b class="ok">{{ cache.hits }}</b><span>命中</span></div>
        <div class="c"><b class="warn">{{ cache.misses }}</b><span>未命中</span></div>
        <div class="c"><b>{{ cache.size }}</b><span>缓存张数</span></div>
      </div>

      <div class="spark">
        <span
          v-for="(s, i) in samples"
          :key="i"
          :style="{ height: barHeight(s.ms), background: s.cached ? '#7ee2b8' : '#ffb45c' }"
          :title="`${s.cached ? '命中' : '渲染'} ${s.ms.toFixed(2)}ms`"
        />
        <div v-if="!samples.length" class="spark-empty">等待瓦片请求…</div>
      </div>

      <div class="perf">
        <div class="p-row"><span>最近一次</span><b>{{ lastMsText }}</b></div>
        <div class="p-row"><span>WMS 平均</span><b>{{ wmsAvg ? wmsAvg.toFixed(2) : '—' }} ms</b></div>
        <div class="p-row"><span>缓存上限</span><b>200 张</b></div>
      </div>

      <code class="url">{{ lastUrl || tileUrl(zoomLevel, 0, 0) }}</code>
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

/* ---------------- 左 ---------------- */
.left {
  left: 14px;
  top: 14px;
  width: 292px;
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
.svc-name {
  font-size: 12.5px;
  font-weight: 600;
  color: #eaf2fb;
}
.svc-url {
  font-size: 10px;
  color: #7d8fa3;
  margin-top: 2px;
}
.kv {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #7d8fa3;
  padding: 4px 0;
  border-bottom: 1px dashed rgba(90, 112, 138, 0.18);
}
.kv b {
  color: #a9bccf;
  font-weight: 500;
  font-family: ui-monospace, Menlo, monospace;
}

.modes {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.mode {
  flex: 1;
  padding: 7px 6px;
  border-radius: 7px;
  border: 1px solid rgba(90, 112, 138, 0.35);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}
.mode b {
  display: block;
  font-size: 11.5px;
  color: #c3cfdb;
  font-weight: 600;
}
.mode span {
  display: block;
  font-size: 9px;
  color: #6f8296;
  margin-top: 2px;
}
.mode:hover {
  border-color: rgba(79, 157, 255, 0.5);
}
.mode.on {
  background: rgba(79, 157, 255, 0.16);
  border-color: rgba(79, 157, 255, 0.65);
}
.mode.on b {
  color: #eaf2fb;
}

.layers {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 10px;
}
.chip {
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid rgba(90, 112, 138, 0.4);
  background: transparent;
  color: #8fa4b9;
  font-size: 10.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.chip i {
  font-style: normal;
  font-size: 9px;
  color: #5d7186;
  margin-left: 4px;
}
.chip.on {
  background: rgba(79, 157, 255, 0.16);
  border-color: rgba(79, 157, 255, 0.55);
  color: #cfe0f2;
}
.chip.on i {
  color: #7bbcff;
}

.acts {
  display: flex;
  gap: 6px;
  margin-top: 10px;
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
.tip {
  margin-top: 8px;
  font-size: 10px;
  line-height: 1.45;
  color: #6f8296;
}

/* ---------------- 右 ---------------- */
.right {
  right: 14px;
  bottom: 14px;
  width: 268px;
  padding: 11px 12px 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.25);
  font-size: 11.5px;
  color: #c8d6e5;
}
.badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 9px;
  background: rgba(70, 211, 154, 0.16);
  color: #6ee7b7;
}
.badge.wms {
  background: rgba(255, 180, 92, 0.16);
  color: #ffb45c;
}
.big {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin: 9px 0 8px;
}
.big .n {
  font-size: 30px;
  line-height: 1;
  color: #eaf2fb;
  font-variant-numeric: tabular-nums;
}
.big .n i {
  font-style: normal;
  font-size: 13px;
  color: #7d8fa3;
  margin-left: 1px;
}
.big .l {
  font-size: 10px;
  color: #7d8fa3;
}
.grid {
  display: flex;
  gap: 6px;
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
  color: #cfe0f2;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
.c b.ok {
  color: #7ee2b8;
}
.c b.warn {
  color: #ffb45c;
}
.c span {
  font-size: 9px;
  color: #7d8fa3;
}

.spark {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 44px;
  margin-top: 10px;
  padding: 4px 5px;
  border-radius: 7px;
  background: rgba(8, 13, 20, 0.6);
  border: 1px solid rgba(90, 112, 138, 0.18);
  position: relative;
}
.spark span {
  flex: 1;
  min-width: 2px;
  border-radius: 1px;
  transition: height 0.18s ease;
}
.spark-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9.5px;
  color: #5d7186;
}

.perf {
  margin-top: 9px;
}
.p-row {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #8fa4b9;
  padding: 2px 0;
}
.p-row b {
  color: #7ee2b8;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.url {
  display: block;
  margin-top: 8px;
  padding: 5px 6px;
  border-radius: 5px;
  background: rgba(8, 13, 20, 0.7);
  color: #86a2bb;
  font-size: 8.5px;
  line-height: 1.45;
  max-height: 46px;
  overflow: hidden;
  word-break: break-all;
}
</style>
