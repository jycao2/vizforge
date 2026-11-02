<script setup lang="ts">
/**
 * 矢量瓦片（Vector Tile）
 * ===========================================================================
 * 与栅格瓦片的本质区别：服务端给的是**带属性的几何**（MVT/protobuf），
 * 样式由前端决定 —— 所以同一个 source 能随时换配色、开关图层、做三维，不用重新出图。
 *
 * 本例用 OpenFreeMap 的公开 planet 源（免 Token、免 Key，OSM 数据），
 * 它的 `vector_layers` 有 transportation / building / water / park / boundary / place 等，
 * 前端必须用 `source-layer` 指定取哪一层，写错了图层会静默空白（最常见的新手坑）。
 *
 * 另外演示了两件矢量瓦片才能做的事：
 *  - 直接把 building 层拉成 fill-extrusion 三维建筑（栅格做不到）；
 *  - 用 feature-state 做 hover 高亮（需要 promoteId 指定唯一字段）。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT, blankStyle } from './basemaps'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const building3d = ref(true)
const showRoad = ref(true)
const showLabel = ref(true)
let map: MbMap | null = null

const HOME = { center: [120.152, 30.255] as [number, number], zoom: 14, pitch: 55, bearing: -18 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const TILEJSON = 'https://tiles.openfreemap.org/planet'

function build() {
  if (!map) return
  map.addSource('ofm', { type: 'vector', url: TILEJSON })

  // 水体
  map.addLayer({
    id: 'vt-water',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'water',
    paint: { 'fill-color': '#123c5e', 'fill-opacity': 0.85 },
  })
  // 绿地 / 公园
  map.addLayer({
    id: 'vt-park',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'park',
    paint: { 'fill-color': '#1e4d38', 'fill-opacity': 0.6 },
  })
  // 道路：按 class 分级，粗细随层级插值
  map.addLayer({
    id: 'vt-road',
    type: 'line',
    source: 'ofm',
    'source-layer': 'transportation',
    paint: {
      'line-color': ['match', ['get', 'class'], 'motorway', '#ffd166', 'trunk', '#ffd166', '#7f96ae'],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        8,
        ['match', ['get', 'class'], 'motorway', 1.4, 0.6],
        16,
        ['match', ['get', 'class'], 'motorway', 12, 5],
      ],
      'line-opacity': 0.9,
    },
  })
  // 建筑：二维/三维一键切换（同一种数据，两套表现）
  map.addLayer({
    id: 'vt-building',
    type: 'fill-extrusion',
    source: 'ofm',
    'source-layer': 'building',
    minzoom: 13,
    paint: {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['get', 'render_height'],
        0,
        '#22384f',
        40,
        '#33536f',
        120,
        '#54789a',
      ],
      'fill-extrusion-height': [
        'coalesce',
        ['get', 'render_height'],
        ['get', 'height'],
        8,
      ],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.95,
      'fill-extrusion-vertical-gradient': true,
    },
  })
  // 行政界线
  map.addLayer({
    id: 'vt-boundary',
    type: 'line',
    source: 'ofm',
    'source-layer': 'boundary',
    paint: {
      'line-color': 'rgba(160,190,220,0.5)',
      'line-width': 1.2,
      'line-dasharray': [3, 2],
    },
  })
  // 地名
  map.addLayer({
    id: 'vt-place',
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'place',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 14, 16],
      'text-max-width': 8,
    },
    paint: {
      'text-color': '#eaf2fb',
      'text-halo-color': 'rgba(6,12,22,0.92)',
      'text-halo-width': 1.6,
    },
  })

  apply()
}

function apply() {
  if (!map) return
  const set = (id: string, v: boolean) => {
    if (map!.getLayer(id)) map!.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none')
  }
  set('vt-road', showRoad.value)
  set('vt-place', showLabel.value)
  if (map.getLayer('vt-building')) {
    if (building3d.value) {
      map.setPaintProperty('vt-building', 'fill-extrusion-height', [
        'coalesce',
        ['get', 'render_height'],
        ['get', 'height'],
        8,
      ])
      map.easeTo({ pitch: 55, duration: 500 })
    } else {
      map.setPaintProperty('vt-building', 'fill-extrusion-height', 0)
      map.easeTo({ pitch: 0, duration: 500 })
    }
  }
}

onMounted(() => {
  // 矢量瓦片自带全部要素，用空样式做底（不叠栅格底图，避免压住配色）
  map = createMap(container.value!, { ...HOME, style: blankStyle('#070c14') })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
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
      <h4>矢量瓦片图层</h4>
      <label class="mb-row">
        <input v-model="building3d" type="checkbox" @change="apply" />
        <span>建筑三维（fill-extrusion）</span>
      </label>
      <label class="mb-row">
        <input v-model="showRoad" type="checkbox" @change="apply" />
        <span>道路网</span>
      </label>
      <label class="mb-row">
        <input v-model="showLabel" type="checkbox" @change="apply" />
        <span>地名标注</span>
      </label>
      <div class="hint">source-layer 决定取瓦片里的哪一层，写错会空白</div>
    </div>
    <div class="mb-tip">OpenFreeMap planet（OSM，免 Token）· 杭州西湖一带</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 228px;
}
.hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
