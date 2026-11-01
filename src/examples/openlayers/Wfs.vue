<script setup lang="ts">
/**
 * WFS 矢量图层
 * ===========================================================================
 * WMS 把图层画成图片，WFS 把要素交给你 —— 这是两者的根本分界。
 * 所以这个示例不只"把线画出来"，而是完整走一遍要素级操作：
 *
 *   GetFeature（带 CQL / bbox）→ 客户端符号化 → 点选查属性
 *   → 改属性 / 拖几何 / 删除 / 新增 → Transaction 写回服务端 → 重新拉取校验
 *
 * 属性表里的每个数字都来自服务端，改完立刻回写；服务端要素计数会跟着变，
 * 这就是 WFS-T（Transaction）与"前端假编辑"的区别。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import GeoJSON from 'ol/format/GeoJSON'
import type { FeatureLike } from 'ol/Feature'
import Select from 'ol/interaction/Select'
import Modify from 'ol/interaction/Modify'
import { click } from 'ol/events/condition'
import Style from 'ol/style/Style'
import Fill from 'ol/style/Fill'
import Stroke from 'ol/style/Stroke'
import CircleStyle from 'ol/style/Circle'
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj'
import type { MapBrowserEvent } from 'ol'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import {
  EXTENT,
  describeFeatureType,
  getFeature,
  listLayers,
  onRequest,
  transaction,
  type LayerMeta,
  type TransactionResult,
} from '@/examples/shared/ogc'

/* ------------------------------ 图层定义 ------------------------------ */

interface LayerDef {
  name: string
  title: string
  short: string
  /** 一句话说明这个图层适合演示什么 */
  hint: string
}

const LAYERS: LayerDef[] = [
  { name: 'city:builtup', title: '建成区（面）', short: '面', hint: '67 个面要素，适合看属性表、改属性与删除' },
  { name: 'city:roads', title: '干线公路（线）', short: '线', hint: '20 条线，拖动节点会直接改几何' },
  { name: 'city:sensors', title: '感知站点（点）', short: '点', hint: '1.2 万个点，可在地图上新增' },
]

const layerName = ref('city:builtup')
const currentLayer = computed(() => LAYERS.find((l) => l.name === layerName.value) ?? LAYERS[0])

const metas = ref<Map<string, LayerMeta>>(new Map())
const fields = computed(() => metas.value.get(layerName.value)?.fields ?? [])
const isPoint = computed(() => metas.value.get(layerName.value)?.type === 'Point')

/** 服务端要素数（每次事务后刷新，用来证明数据真的改了） */
const serverCount = ref(0)
const shownCount = ref(0)

/* ------------------------------ 样式 ------------------------------ */

const PM_STOPS: Array<[number, string]> = [
  [0, '#2f9e6f'],
  [50, '#d8c33a'],
  [75, '#e0883a'],
  [110, '#c8322f'],
]

function ramp(v: number): string {
  if (!Number.isFinite(v)) return '#8fa4b9'
  if (v <= PM_STOPS[0][0]) return PM_STOPS[0][1]
  for (let i = 1; i < PM_STOPS.length; i++) {
    if (v <= PM_STOPS[i][0]) {
      const [v0, c0] = PM_STOPS[i - 1]
      const [v1, c1] = PM_STOPS[i]
      const k = (v - v0) / (v1 - v0 || 1)
      return mix(c0, c1, k)
    }
  }
  return PM_STOPS[PM_STOPS.length - 1][1]
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [r1, g1, b1] = p(a)
  const [r2, g2, b2] = p(b)
  const k = Math.max(0, Math.min(1, t))
  return `rgb(${Math.round(r1 + (r2 - r1) * k)},${Math.round(g1 + (g2 - g1) * k)},${Math.round(b1 + (b2 - b1) * k)})`
}

function alpha(color: string, a: number): string {
  if (color.startsWith('#')) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    return `rgba(${r},${g},${b},${a})`
  }
  return color
}

function styleFor(f: FeatureLike): Style {
  const name = layerName.value
  if (name === 'city:builtup') {
    const pop = Number(f.get('population') ?? 0)
    const color = pop > 800 ? '#e0663a' : pop > 300 ? '#d99a3c' : '#c9b04a'
    return new Style({
      fill: new Fill({ color: alpha(color, 0.5) }),
      stroke: new Stroke({ color, width: 1.4 }),
    })
  }
  if (name === 'city:roads') {
    const lv = Number(f.get('level') ?? 2)
    return new Style({
      stroke: new Stroke({ color: lv === 1 ? '#5aa9ff' : '#7fd0b0', width: lv === 1 ? 2.4 : 1.5 }),
    })
  }
  const pm = Number(f.get('pm25') ?? 0)
  return new Style({
    image: new CircleStyle({
      radius: 3.4,
      fill: new Fill({ color: ramp(pm) }),
      stroke: new Stroke({ color: 'rgba(8,14,22,0.6)', width: 0.8 }),
    }),
  })
}

const SELECT_STYLE = new Style({
  fill: new Fill({ color: 'rgba(79,157,255,0.28)' }),
  stroke: new Stroke({ color: '#ffffff', width: 2.4 }),
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: 'rgba(79,157,255,0.6)' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
})

/* ------------------------------ 地图 ------------------------------ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlMap | null = null
let source: VectorSource | null = null
let select: Select | null = null
let modify: Modify | null = null

const DATA_EXTENT = transformExtent([EXTENT.w, EXTENT.s, EXTENT.e, EXTENT.n], 'EPSG:4326', 'EPSG:3857')
const CENTER = fromLonLat([(EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2])
const { zoomBy, toggleFullscreen } = useOlView(() => map, CENTER, 7.2)
const { current: currentBasemap, create, apply } = useOlBasemap('dark')
const geoJson = new GeoJSON()

function reset() {
  const narrow = (wrapRef.value?.clientWidth ?? 1200) < 900
  map?.getView().fit(DATA_EXTENT, {
    padding: narrow ? [24, 24, 24, 24] : [26, 40, 34, 320],
    duration: 320,
  })
}

/** 切换图层：改状态 → 清过滤 → 重新 GetFeature */
function selectLayer(name: string) {
  if (layerName.value === name) return
  layerName.value = name
  cql.value = ''
  cqlError.value = ''
  refresh()
}

/* ------------------------------ 属性表 ------------------------------ */

const selectedId = ref<number | null>(null)
const editProps = ref<Record<string, string>>({})

function onSelect() {
  if (!select) return
  const f = select.getFeatures().item(0)
  if (!f) {
    selectedId.value = null
    editProps.value = {}
    return
  }
  selectedId.value = Number(f.getId())
  const next: Record<string, string> = {}
  for (const fd of fields.value) next[fd.name] = String(f.get(fd.name) ?? '')
  editProps.value = next
}

/* ------------------------------ 事务 ------------------------------ */

const txLog = ref<Array<{ action: string; msg: string; ms: number; count: number }>>([])
const toastMsg = ref('')
let toastTimer = 0

function toast(msg: string) {
  toastMsg.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastMsg.value = ''), 2200)
}

function pushTx(action: string, r: TransactionResult) {
  txLog.value = [
    { action, msg: r.message, ms: r.ms, count: r.count },
    ...txLog.value,
  ].slice(0, 5)
}

/** 提交属性修改（update） */
function commitProps() {
  if (selectedId.value == null || !source) return
  const props: Record<string, string | number> = {}
  for (const fd of fields.value) {
    const raw = editProps.value[fd.name] ?? ''
    props[fd.name] = fd.type === 'number' ? Number(raw) : raw
  }
  const r = transaction([
    { action: 'update', layer: layerName.value, id: selectedId.value, feature: { properties: props } },
  ])
  pushTx('update', r)
  toast(`已提交 #${selectedId.value} 的属性修改`)
  refresh(selectedId.value)
}

/** 删除选中要素（delete） */
function removeSelected() {
  if (selectedId.value == null) return
  const r = transaction([{ action: 'delete', layer: layerName.value, id: selectedId.value }])
  pushTx('delete', r)
  toast(`已删除 #${selectedId.value}`)
  refresh()
}

/** 新增要素（insert）：只在点图层启用，点击地图落点 */
const inserting = ref(false)

function startInsert() {
  if (!isPoint.value) {
    toast('新增只对点图层开放（面/线需要至少两个坐标）')
    return
  }
  inserting.value = true
  select?.setActive(false)
  toast('在地图上点击以新增一个感知站点')
}

function onMapClick(evt: MapBrowserEvent<MouseEvent>) {
  if (!inserting.value) return
  const [lon, lat] = toLonLat(evt.coordinate)
  const r = transaction([
    {
      action: 'insert',
      layer: 'city:sensors',
      feature: {
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { name: '新增点位', type: '空气站', city: '手动添加', pm25: 42, level: 'low' },
      },
    },
  ])
  pushTx('insert', r)
  inserting.value = false
  select?.setActive(true)
  toast(`已新增 1 个要素，服务端现有 ${r.count} 个`)
  refresh()
}

/* ------------------------------ 数据加载 ------------------------------ */

function serverTotal(): number {
  return listLayers().find((l) => l.name === layerName.value)?.count ?? 0
}

/**
 * GetFeature 拉取 → GeoJSON → VectorSource。
 * @param keepId 提交修改后要重新选中的要素 id
 */
function refresh(keepId?: number) {
  if (!source) return
  const res = getFeature(layerName.value, { cql: cql.value, count: 20000 })
  const feats = geoJson.readFeatures(
    { type: 'FeatureCollection', features: res.features as never },
    { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' },
  )
  // 统一 id 为字符串，避免 getFeatureById 数字/字符串不一致
  for (const f of feats) f.setId(String(f.getId()))
  source.clear()
  source.addFeatures(feats)
  shownCount.value = feats.length
  serverCount.value = serverTotal()

  if (keepId != null) {
    const target = source.getFeatureById(String(keepId))
    if (target && select) {
      select.getFeatures().clear()
      select.getFeatures().push(target)
      onSelect()
    }
  } else {
    select?.getFeatures().clear()
    selectedId.value = null
    editProps.value = {}
  }
}

/* ------------------------------ CQL ------------------------------ */

const cql = ref('')
const cqlError = ref('')

function applyCql() {
  const text = cql.value.trim()
  cqlError.value = ''
  if (text) {
    const ok = /LIKE\s+\S+/i.test(text) || /[A-Za-z_][\w.]*\s*(>=|<=|!=|<>|=|>|<)\s*[^\s()]+/.test(text)
    if (!ok) {
      cqlError.value = '条件不完整，例如 population > 300'
      return
    }
  }
  const before = shownCount.value
  refresh()
  toast(`GetFeature 完成：${before} → ${shownCount.value} 个要素`)
}

/* ------------------------------ 字段定义弹层 ------------------------------ */

const xsdOpen = ref(false)
const xsd = ref('')

function openXsd() {
  xsd.value = describeFeatureType(layerName.value)
  xsdOpen.value = true
}

/* ------------------------------ 统计 ------------------------------ */

const reqCount = ref(0)
let wfsReq = 0

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(() => {
  for (const m of listLayers()) metas.value.set(m.name, m)

  const base = create()
  source = new VectorSource()
  const vector = new VectorLayer({
    source,
    style: styleFor as (f: FeatureLike) => Style,
  })

  map = new OlMap({
    target: container.value!,
    layers: [base, vector],
    view: new View({ center: CENTER, zoom: 7.2, minZoom: 5, maxZoom: 15 }),
  })
  reset()

  select = new Select({ condition: click, style: SELECT_STYLE })
  select.on('select', onSelect)
  map.addInteraction(select)

  modify = new Modify({ source, features: select.getFeatures() })
  modify.on('modifyend', (e) => {
    const gj = new GeoJSON()
    for (const f of e.features.getArray()) {
      const geom = gj.writeGeometryObject(f.getGeometry()!, {
        featureProjection: 'EPSG:3857',
        dataProjection: 'EPSG:4326',
      })
      const r = transaction([
        {
          action: 'update',
          layer: layerName.value,
          id: Number(f.getId()),
          feature: { geometry: geom as unknown as { type: 'Point'; coordinates: unknown } },
        },
      ])
      pushTx('update', r)
    }
    toast('几何已写回服务端')
  })
  map.addInteraction(modify)

  map.on('singleclick', onMapClick)

  const off = onRequest((l) => {
    if (l.op === 'GetFeature' || l.op === 'Transaction') {
      wfsReq++
      reqCount.value = wfsReq
    }
  })
  onBeforeUnmount(() => off())

  refresh()
})

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
  map?.setTarget(undefined)
  map = null
  source = null
  select = null
  modify = null
})
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
          <div class="svc-name">WFS 2.0.0 · 内置实例</div>
          <div class="svc-url">/geoserver/wfs · typeNames=city:*</div>
        </div>
        <button class="mini" @click="openXsd">字段定义</button>
      </div>

      <div class="seg">
        <button
          v-for="l in LAYERS"
          :key="l.name"
          class="seg-btn"
          :class="{ on: l.name === layerName }"
          @click="selectLayer(l.name)"
        >
          <span class="q">{{ l.short }}</span>{{ l.title }}
        </button>
      </div>
      <div class="hint">{{ currentLayer.hint }}</div>

      <div class="cql-row">
        <input v-model="cql" class="cql" :class="{ bad: cqlError }" placeholder="population > 300" @keydown.enter="applyCql" />
        <button class="mini solid" @click="applyCql">GetFeature</button>
      </div>
      <div v-if="cqlError" class="err">{{ cqlError }}</div>

      <div class="counts">
        <div class="c"><b>{{ serverCount }}</b><span>服务端要素</span></div>
        <div class="c"><b>{{ shownCount }}</b><span>当前返回</span></div>
        <div class="c"><b>{{ reqCount }}</b><span>请求数</span></div>
      </div>

      <div class="acts">
        <button class="mini" :class="{ on: inserting }" @click="startInsert">＋ 新增点</button>
        <button class="mini danger" :disabled="selectedId == null" @click="removeSelected">删除选中</button>
      </div>
      <div class="tip">点选要素看属性；拖动要素可改几何，松开即提交。</div>
    </div>

    <!-- 右：属性表 -->
    <div class="panel right">
      <div class="head">
        <span>属性表</span>
        <span v-if="selectedId != null" class="fid">#{{ selectedId }}</span>
      </div>

      <div v-if="selectedId == null" class="empty">
        点击地图上的要素<br />查看 / 编辑它的属性
      </div>

      <template v-else>
        <div class="rows">
          <div v-for="fd in fields" :key="fd.name" class="field">
            <label :title="fd.note || fd.name">{{ fd.name }}</label>
            <input v-model="editProps[fd.name]" :placeholder="fd.type === 'number' ? '0' : ''" />
          </div>
        </div>
        <button class="commit" @click="commitProps">提交修改（Transaction）</button>
        <div class="tip2">改完点提交，数据会写回服务端并重新拉取校验。</div>
      </template>
    </div>

    <!-- 左下：事务日志 -->
    <div class="panel txs">
      <div class="tx-head">
        <span>WFS-T 事务</span>
        <span class="tx-sub">最近 {{ txLog.length }} 条</span>
      </div>
      <div v-for="(t, i) in txLog" :key="i" class="tx">
        <span class="tx-tag" :class="t.action">{{ t.action }}</span>
        <span class="tx-msg">{{ t.msg }}</span>
        <span class="tx-meta">{{ t.count }} 个 · {{ t.ms.toFixed(1) }}ms</span>
      </div>
      <div v-if="!txLog.length" class="tx-empty">还没有事务。改个属性或拖个要素试试。</div>
    </div>

    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>

    <!-- 字段定义 -->
    <div v-if="xsdOpen" class="mask" @click.self="xsdOpen = false">
      <div class="xsd">
        <div class="xsd-head">
          <span>DescribeFeatureType · {{ layerName }}</span>
          <button class="mini" @click="xsdOpen = false">关闭</button>
        </div>
        <pre>{{ xsd }}</pre>
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
  font-size: 10px;
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
.mini:hover:not(:disabled) {
  border-color: #4f9dff;
  color: #7bbcff;
}
.mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mini.solid {
  background: #2f6fd0;
  border-color: #2f6fd0;
  color: #fff;
}
.mini.on {
  background: #2f6fd0;
  border-color: #2f6fd0;
  color: #fff;
}
.mini.danger:hover:not(:disabled) {
  border-color: #e0614b;
  color: #ef8368;
}

.seg {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 9px;
}
.seg-btn {
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(90, 112, 138, 0.35);
  background: transparent;
  color: #c3cfdb;
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.seg-btn:hover {
  border-color: rgba(79, 157, 255, 0.55);
}
.seg-btn.on {
  background: rgba(79, 157, 255, 0.16);
  border-color: rgba(79, 157, 255, 0.65);
  color: #eaf2fb;
}
.q {
  display: inline-block;
  padding: 0 3px;
  margin-right: 5px;
  border-radius: 3px;
  background: rgba(120, 160, 200, 0.18);
  color: #9db6cd;
  font-size: 9.5px;
}
.hint {
  margin-top: 6px;
  font-size: 10px;
  color: #6f8296;
  line-height: 1.4;
}

.cql-row {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.cql {
  flex: 1;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 5px;
  border: 1px solid rgba(90, 112, 138, 0.5);
  background: rgba(8, 13, 20, 0.7);
  color: #cfe0f2;
  font-family: ui-monospace, Menlo, monospace;
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

.counts {
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
  font-size: 14px;
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.c span {
  font-size: 9px;
  color: #7d8fa3;
}

.acts {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}
.acts .mini {
  flex: 1;
  padding: 5px 0;
}
.tip {
  margin-top: 8px;
  font-size: 10px;
  color: #6f8296;
  line-height: 1.45;
}

/* ---------------- 右 ---------------- */
.right {
  right: 14px;
  top: 236px;
  width: 248px;
  padding: 11px 12px 12px;
  max-height: 400px;
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.25);
  font-size: 11.5px;
  color: #c8d6e5;
}
.fid {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10px;
  color: #7bbcff;
}
.empty {
  padding: 26px 0;
  text-align: center;
  font-size: 11px;
  line-height: 1.7;
  color: #63768a;
}
.rows {
  overflow: auto;
  margin: 9px 0;
  flex: 1;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}
.field label {
  width: 84px;
  flex: none;
  font-size: 10px;
  color: #8fa4b9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.field input {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 4px;
  border: 1px solid rgba(90, 112, 138, 0.45);
  background: rgba(8, 13, 20, 0.7);
  color: #dfe9f4;
  font-size: 10.5px;
  outline: none;
}
.field input:focus {
  border-color: #4f9dff;
}
.commit {
  width: 100%;
  padding: 6px 0;
  border-radius: 6px;
  border: none;
  background: linear-gradient(180deg, #3f86e0, #2f6fd0);
  color: #fff;
  font-size: 11.5px;
  cursor: pointer;
}
.commit:hover {
  filter: brightness(1.1);
}
.tip2 {
  margin-top: 6px;
  font-size: 9.5px;
  color: #6f8296;
  line-height: 1.45;
}

/* ---------------- 事务日志 ---------------- */
.txs {
  left: 14px;
  bottom: 14px;
  width: 292px;
  padding: 9px 11px;
}
.tx-head {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: #9db6cd;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.22);
}
.tx-sub {
  color: #5d7186;
  font-size: 9.5px;
}
.tx {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 10px;
  color: #8fa4b9;
}
.tx-tag {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 9px;
  flex: none;
  background: rgba(120, 160, 200, 0.18);
  color: #9db6cd;
}
.tx-tag.insert {
  background: rgba(70, 211, 154, 0.18);
  color: #6ee7b7;
}
.tx-tag.update {
  background: rgba(79, 157, 255, 0.18);
  color: #7bbcff;
}
.tx-tag.delete {
  background: rgba(224, 97, 75, 0.18);
  color: #ef8368;
}
.tx-msg {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tx-meta {
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
  flex: none;
}
.tx-empty {
  padding: 8px 0 3px;
  font-size: 10px;
  color: #5d7186;
}

/* ---------------- 提示条 ---------------- */
.toast {
  position: absolute;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  z-index: 30;
  padding: 7px 14px;
  border-radius: 999px;
  background: rgba(24, 36, 50, 0.94);
  border: 1px solid rgba(79, 157, 255, 0.45);
  color: #cfe0f2;
  font-size: 11.5px;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
}

/* ---------------- 字段定义 ---------------- */
.mask {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(6, 10, 16, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
}
.xsd {
  width: 620px;
  max-width: 86vw;
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.98);
  border: 1px solid rgba(90, 112, 138, 0.45);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}
.xsd-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 11px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.3);
  font-size: 11.5px;
  color: #c8d6e5;
}
.xsd pre {
  margin: 0;
  padding: 11px 13px;
  overflow: auto;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10px;
  line-height: 1.55;
  color: #8fb0cc;
}
</style>
