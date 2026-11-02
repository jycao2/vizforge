<script setup lang="ts">
/**
 * 绘制与量测
 * ===========================================================================
 * 生产环境一般用 mapbox-gl-draw 这类库，但库替你做的事也就是这几件，
 * 本例手写一遍，方便看清机制：
 *
 *  - 单击加点 → 鼠标移动时把「光标点」临时接到顶点序列末尾做预览；
 *  - 双击收尾（双击会先派发两次 click，第二次 detail === 2，必须过滤，否则多一个点）；
 *  - 量测用球面公式：长度 Haversine 逐段累加，面积用纬带梯形积分（与 OL 侧同算法），
 *    直接拿经纬度差算平面距离在北纬 30° 会差 13%；
 *  - 绘制期间关掉 doubleClickZoom，否则结束那一下顺带把地图放大一级；
 *  - 图形落到独立 source，双击结束后统一 push 到结果列表。
 *
 * 工具栏上的「测距 / 测面」是另一套实现（measureMapbox.ts），与本例互不影响，
 * 两套都在是为了对比：工具栏版偏量测，本例偏"我要留下这些图形"。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap, MapMouseEvent, GeoJSONSource } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { createMap, useMapboxView } from './useMapbox'
import { fc, feat } from './data'
import { fmtArea, fmtLength, sphericalArea } from '@/components/measureShared'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const mode = ref<'line' | 'area' | 'point'>('area')
const live = ref('')
const shapes = ref<Array<{ id: number; kind: string; text: string }>>([])
let map: MbMap | null = null

type LL = [number, number]
const HOME = { center: [120.15, 30.26] as LL, zoom: 13 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

let pts: LL[] = []
let cursor: LL | null = null
let seq = 0
/** 已完成的图形自己留一份：GeoJSONSource 没有 getData()，回写时要知道原有内容 */
const store: GeoJSON.Feature[] = []

function haversine(a: LL, b: LL): number {
  const R = 6378137
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
function lengthOf(list: LL[]): number {
  let s = 0
  for (let i = 1; i < list.length; i++) s += haversine(list[i - 1], list[i])
  return s
}

function build() {
  if (!map) return
  map.addSource('draft', { type: 'geojson', data: fc([]) })
  map.addSource('shapes', { type: 'geojson', data: fc([]) })

  map.addLayer({
    id: 'draft-fill',
    type: 'fill',
    source: 'draft',
    filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': '#4f9dff', 'fill-opacity': 0.18 },
  })
  map.addLayer({
    id: 'draft-line',
    type: 'line',
    source: 'draft',
    paint: { 'line-color': '#7bbcff', 'line-width': 2, 'line-dasharray': [2, 1.5] },
  })
  map.addLayer({
    id: 'draft-dot',
    type: 'circle',
    source: 'draft',
    filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': 4,
      'circle-color': '#fff',
      'circle-stroke-width': 1.6,
      'circle-stroke-color': '#2f6fd0',
    },
  })

  map.addLayer({
    id: 'shapes-fill',
    type: 'fill',
    source: 'shapes',
    filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': '#ffd166', 'fill-opacity': 0.16 },
  })
  map.addLayer({
    id: 'shapes-line',
    type: 'line',
    source: 'shapes',
    paint: { 'line-color': '#ffd166', 'line-width': 2.4 },
  })
  map.addLayer({
    id: 'shapes-dot',
    type: 'circle',
    source: 'shapes',
    filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#ffd166',
      'circle-stroke-width': 1.6,
      'circle-stroke-color': 'rgba(8,14,22,0.9)',
    },
  })
  map.addLayer({
    id: 'shapes-text',
    type: 'symbol',
    source: 'shapes',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': [MB_FONT],
      'text-size': 11.5,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
    },
    paint: { 'text-color': '#ffe9b0', 'text-halo-color': 'rgba(6,12,22,0.9)', 'text-halo-width': 1.4 },
  })

  map.on('click', onClick)
  map.on('mousemove', onMove)
  map.on('dblclick', onFinish)
}

function draftData(): GeoJSON.FeatureCollection {
  const list = cursor ? [...pts, cursor] : pts
  const out: GeoJSON.Feature[] = pts.map((p) => feat({ type: 'Point', coordinates: p }))
  if (list.length >= 2 && mode.value !== 'point') {
    out.push(feat({ type: 'LineString', coordinates: list }))
  }
  if (mode.value === 'area' && list.length >= 3) {
    out.push(feat({ type: 'Polygon', coordinates: [[...list, list[0]]] }))
  }
  return fc(out)
}

function reading(): string {
  const list = cursor ? [...pts, cursor] : pts
  if (mode.value === 'point') return pts.length ? `已落 ${pts.length} 个点` : '单击落点'
  if (list.length < 2) return '再点一点'
  if (mode.value === 'line') return fmtLength(lengthOf(list))
  const ring = [...list, list[0]]
  return `${fmtArea(sphericalArea(ring))} · 周长 ${fmtLength(lengthOf(ring))}`
}

function flush() {
  if (!map) return
  ;(map.getSource('draft') as GeoJSONSource).setData(draftData())
  live.value = reading()
}

function onClick(e: MapMouseEvent) {
  // 双击的第二次 click 不能算加点
  if ((e.originalEvent as MouseEvent).detail > 1) return
  const p: LL = [e.lngLat.lng, e.lngLat.lat]
  if (mode.value === 'point') {
    commit([p])
    return
  }
  pts.push(p)
  flush()
}

function onMove(e: MapMouseEvent) {
  if (mode.value === 'point') return
  cursor = [e.lngLat.lng, e.lngLat.lat]
  flush()
}

function commit(list: LL[]) {
  if (!map) return
  const label =
    list.length === 1
      ? `点 ${++seq}`
      : mode.value === 'line'
        ? fmtLength(lengthOf(list))
        : fmtArea(sphericalArea([...list, list[0]]))
  const geom: GeoJSON.Geometry =
    list.length === 1
      ? { type: 'Point', coordinates: list[0] }
      : mode.value === 'line'
        ? { type: 'LineString', coordinates: list }
        : { type: 'Polygon', coordinates: [[...list, list[0]]] }
  const f = feat(geom, { label })
  const src = map.getSource('shapes') as GeoJSONSource
  store.push(f)
  src.setData(fc(store))
  shapes.value.push({ id: ++seq, kind: mode.value === 'line' ? '线' : mode.value === 'area' ? '面' : '点', text: label })
}

function onFinish() {
  if (mode.value !== 'point' && pts.length >= (mode.value === 'line' ? 2 : 3)) commit(pts)
  pts = []
  cursor = null
  flush()
}

function undo() {
  pts.pop()
  flush()
}

function clearAll() {
  pts = []
  cursor = null
  store.length = 0
  shapes.value = []
  seq = 0
  if (map) (map.getSource('shapes') as GeoJSONSource).setData(fc([]))
  flush()
}

function setMode(m: 'line' | 'area' | 'point') {
  mode.value = m
  pts = []
  cursor = null
  flush()
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
  // 绘制期间禁掉双击缩放，否则"结束绘制"会顺带放大地图
  map!.doubleClickZoom.disable()
})

onBeforeUnmount(() => {
  map?.remove()
  map = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>
    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-panel ctrl">
      <h4>绘制</h4>
      <div class="btns">
        <button class="mb-btn" :class="{ on: mode === 'point' }" @click="setMode('point')">点</button>
        <button class="mb-btn" :class="{ on: mode === 'line' }" @click="setMode('line')">线</button>
        <button class="mb-btn" :class="{ on: mode === 'area' }" @click="setMode('area')">面</button>
      </div>
      <div class="live">{{ live || '点击开始' }}</div>
      <div class="btns">
        <button class="mb-btn" @click="undo">撤销点</button>
        <button class="mb-btn" @click="clearAll">清空</button>
      </div>
      <div v-if="shapes.length" class="list">
        <div v-for="s in shapes" :key="s.id" class="li">
          <span>{{ s.kind }}</span><b>{{ s.text }}</b>
        </div>
      </div>
    </div>
    <div class="mb-tip">单击加点 · 双击结束 · 长度/面积均为球面真值</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 216px;
}
.btns {
  display: flex;
  gap: 6px;
  margin: 6px 0;
}
.live {
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(79, 157, 255, 0.14);
  color: #eaf2fb;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.list {
  max-height: 150px;
  overflow: auto;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11.5px;
  padding: 2px 0;
  color: #a9bccf;
}
.li b {
  color: #eaf2fb;
  font-variant-numeric: tabular-nums;
}
</style>
