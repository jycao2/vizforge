<script setup lang="ts">
/**
 * 图层控制
 * ===========================================================================
 * 一个地图往往叠着七八层，控制它们的正确做法不是增删图层，而是：
 *
 *  - 显隐：`setLayoutProperty(id, 'visibility', 'visible' | 'none')`
 *    （切 visibility 不会重传数据，比 removeLayer/addLayer 快得多）；
 *  - 透明度：改 paint 的 *-opacity；
 *  - 顺序：`moveLayer(id, beforeId)`，注意第二个参数是"放到它前面"的图层 id，
 *    传 undefined 表示置顶。
 *
 * 另外演示了 `queryRenderedFeatures` 做图层级统计：打开哪个图层，
 * 面板上就显示当前视口里该图层有多少个要素在画（只统计屏幕内的）。
 */
import { onMounted, onBeforeUnmount, ref, reactive } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { CITIES, blocks, fc, feat, gridPolygons, scatter, track } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const HOME = { center: [116.4, 33.2] as [number, number], zoom: 4.4 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

interface Item {
  id: string
  label: string
  on: boolean
  opacity: number
  /** 这一组可能由多个图层构成（如 POI 的圆 + 文字） */
  layers: string[]
}

const items = reactive<Item[]>([
  { id: 'grid', label: '统计网格（面）', on: true, opacity: 0.7, layers: ['grid-fill', 'grid-line'] },
  { id: 'road', label: '主干道（线）', on: true, opacity: 1, layers: ['road'] },
  { id: 'poi', label: '城市点（点+字）', on: true, opacity: 1, layers: ['poi', 'poi-text'] },
  { id: 'heat', label: '热力（heatmap）', on: false, opacity: 0.9, layers: ['heat'] },
  { id: 'blocks', label: '三维建筑', on: false, opacity: 1, layers: ['blocks'] },
])
const counts = ref<Record<string, number>>({})

function build() {
  if (!map) return
  // 面
  map.addSource('grid', { type: 'geojson', data: gridPolygons([108, 26, 124, 42], 14, 14) })
  map.addLayer({
    id: 'grid-fill',
    type: 'fill',
    source: 'grid',
    paint: {
      'fill-color': ['step', ['get', 'v'], '#123f66', 40, '#1a5c8a', 70, '#2b7fb8', 90, '#66b3d9'],
      'fill-opacity': 0.7,
    },
  })
  map.addLayer({
    id: 'grid-line',
    type: 'line',
    source: 'grid',
    paint: { 'line-color': 'rgba(255,255,255,0.16)', 'line-width': 0.6 },
  })

  // 线
  map.addSource('road', {
    type: 'geojson',
    data: fc([feat({ type: 'LineString', coordinates: track(4, 100) })]),
  })
  map.addLayer({
    id: 'road',
    type: 'line',
    source: 'road',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffd166', 'line-width': 2.6, 'line-opacity': 1 },
  })

  // 点
  map.addSource('poi', {
    type: 'geojson',
    data: fc(CITIES.map((c) => feat({ type: 'Point', coordinates: c.c }, { name: c.name, v: c.v }))),
  })
  map.addLayer({
    id: 'poi',
    type: 'circle',
    source: 'poi',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'v'], 20, 4, 100, 13],
      'circle-color': '#ff6b6b',
      'circle-opacity': 0.9,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(8,14,22,0.8)',
    },
  })
  map.addLayer({
    id: 'poi-text',
    type: 'symbol',
    source: 'poi',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': 11.5,
      'text-offset': [0, 1],
      'text-anchor': 'top',
    },
    paint: { 'text-color': '#eaf2fb', 'text-halo-color': 'rgba(6,12,22,0.9)', 'text-halo-width': 1.4 },
  })

  // 热力
  map.addSource('heat', {
    type: 'geojson',
    data: scatter(7, 2200, [
      [116.39, 39.91],
      [121.47, 31.23],
      [113.26, 23.13],
      [120.15, 30.27],
    ], 1.6),
  })
  map.addLayer({
    id: 'heat',
    type: 'heatmap',
    source: 'heat',
    layout: { visibility: 'none' },
    paint: {
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 16, 9, 60],
      'heatmap-opacity': 0.9,
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0,
        'rgba(0,0,0,0)',
        0.4,
        '#2b7fb8',
        0.7,
        '#ffd166',
        1,
        '#ff4d4d',
      ],
    },
  })

  // 三维建筑（默认关；打开后建议把 pitch 拉起来）
  map.addSource('blocks', {
    type: 'geojson',
    data: blocks([120.14, 30.245], 18, 18, 0.0032, 9),
  })
  map.addLayer({
    id: 'blocks',
    type: 'fill-extrusion',
    source: 'blocks',
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'height'], 12, '#22496e', 160, '#8fd0f0'],
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-opacity': 1,
      'fill-extrusion-vertical-gradient': true,
    },
  })

  refreshCounts()
}

function refreshCounts() {
  if (!map) return
  const c: Record<string, number> = {}
  items.forEach((it) => {
    if (!it.on) return
    c[it.id] = map!.queryRenderedFeatures({ layers: it.layers }).length
  })
  counts.value = c
}

function toggle(it: Item) {
  if (!map) return
  it.layers.forEach((id) => {
    if (map!.getLayer(id)) {
      map!.setLayoutProperty(id, 'visibility', it.on ? 'visible' : 'none')
    }
  })
  refreshCounts()
}

function setOpacity(it: Item, v: number) {
  if (!map) return
  it.opacity = v
  // 各图层类型的 opacity 属性名不同，这里按 id 分派
  const map2: Record<string, string> = {
    'grid-fill': 'fill-opacity',
    'grid-line': 'line-opacity',
    road: 'line-opacity',
    poi: 'circle-opacity',
    'poi-text': 'text-opacity',
    heat: 'heatmap-opacity',
    blocks: 'fill-extrusion-opacity',
  }
  it.layers.forEach((id) => {
    const prop = map2[id]
    if (prop && map!.getLayer(id)) map!.setPaintProperty(id, prop as 'fill-opacity', v)
  })
}

function raise(it: Item) {
  if (!map) return
  it.layers.forEach((id) => {
    if (map!.getLayer(id)) map!.moveLayer(id) // 不传第二个参数 = 置顶
  })
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', () => {
    build()
    map!.on('idle', refreshCounts)
    map!.on('moveend', refreshCounts)
  })
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
      <h4>图层</h4>
      <div v-for="it in items" :key="it.id" class="item">
        <div class="row1">
          <label class="mb-row">
            <input v-model="it.on" type="checkbox" @change="toggle(it)" />
            <span>{{ it.label }}</span>
          </label>
          <button class="mini" title="置顶" @click="raise(it)">↑</button>
        </div>
        <div class="row2">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="it.opacity"
            @input="setOpacity(it, Number(($event.target as HTMLInputElement).value))"
          />
          <b>{{ it.opacity.toFixed(2) }}</b>
          <em v-if="counts[it.id] != null">{{ counts[it.id] }} 个</em>
        </div>
      </div>
    </div>
    <div class="mb-tip">勾选显隐 · 滑块调透明度 · ↑ 置顶 · 计数为当前视口内要素数</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 248px;
  max-height: 76%;
  overflow: auto;
}
.item {
  padding: 5px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}
.item:last-child {
  border-bottom: 0;
}
.row1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.row2 {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-left: 22px;
}
.row2 input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4f9dff;
}
.row2 b {
  width: 32px;
  text-align: right;
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.row2 em {
  color: #8fa4b9;
  font-size: 10.5px;
  font-style: normal;
}
.mini {
  width: 20px;
  height: 20px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.05);
  color: #c6d3e1;
  font-size: 11px;
  cursor: pointer;
}
.mini:hover {
  background: rgba(79, 157, 255, 0.24);
  color: #fff;
}
</style>
