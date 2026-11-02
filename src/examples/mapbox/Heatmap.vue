<script setup lang="ts">
/**
 * 热力图
 * ===========================================================================
 * Mapbox 的 heatmap 是样式层里的原生类型，纯 GPU 聚合，几万点也能实时重画。
 * 三个参数决定观感，本例都做成可调：
 *
 *  - `heatmap-radius`：单点影响半径（像素）。**必须随 zoom 插值**，
 *    否则放大后每点各成一团，看不出密度；
 *  - `heatmap-intensity`：整体强度，通常也随 zoom 增大；
 *  - `heatmap-weight`：取值字段，让"权重高"的点贡献更大（这里用 v / 100）。
 *
 * 配色用 `heatmap-color` 的 interpolate，输入是 0~1 的密度：
 * 末尾要补一个全透明档做羽化，边缘才不会硬切。
 *
 * 另外演示了「热力 ↔ 原始点」切换：缩放到一定层级后热力图会失真，
 * 真实项目常见做法是大层级显示热力、小层级显示散点。
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { Map as MbMap, ExpressionSpecification } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { scatter } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const radius = ref(26)
const intensity = ref(1.1)
const useWeight = ref(true)
const showPoints = ref(false)
let map: MbMap | null = null

const HOME = { center: [114.2, 31.6] as [number, number], zoom: 4.2 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const HEAT_COLOR: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['heatmap-density'],
  0,
  'rgba(8,20,40,0)',
  0.15,
  '#1f6feb',
  0.35,
  '#2b9fd6',
  0.55,
  '#7fd66b',
  0.75,
  '#ffd166',
  0.9,
  '#ff8c42',
  1,
  '#ff4d4d',
]

function build() {
  if (!map) return
  const data = scatter(20261102, 2600, [
    [116.39, 39.91],
    [121.47, 31.23],
    [113.26, 23.13],
    [120.15, 30.27],
    [104.07, 30.57],
  ], 1.5)

  map.addSource('pts', { type: 'geojson', data })

  map.addLayer({
    id: 'heat',
    type: 'heatmap',
    source: 'pts',
    maxzoom: 12,
    paint: {
      'heatmap-weight': useWeight.value ? ['/', ['get', 'v'], 100] : 1,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, intensity.value * 0.6, 9, intensity.value * 2.2],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, radius.value * 0.55, 10, radius.value * 2.4],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.95, 12, 0.5],
      'heatmap-color': HEAT_COLOR,
    },
  })

  // 小层级（放大后）换成散点：热力图在高 zoom 下会把单点无限放大成色块
  map.addLayer({
    id: 'pts-circle',
    type: 'circle',
    source: 'pts',
    minzoom: 9,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 16, 7],
      'circle-color': '#ffd166',
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 11, 0.85],
      'circle-stroke-width': 0,
    },
  })

  apply()
}

function apply() {
  if (!map) return
  map.setPaintProperty('heat', 'heatmap-weight', useWeight.value ? ['/', ['get', 'v'], 100] : 1)
  map.setPaintProperty('heat', 'heatmap-radius', [
    'interpolate',
    ['linear'],
    ['zoom'],
    3,
    radius.value * 0.55,
    10,
    radius.value * 2.4,
  ])
  map.setPaintProperty('heat', 'heatmap-intensity', [
    'interpolate',
    ['linear'],
    ['zoom'],
    3,
    intensity.value * 0.6,
    9,
    intensity.value * 2.2,
  ])
  if (map.getLayer('pts-circle')) {
    map.setLayoutProperty('pts-circle', 'visibility', showPoints.value ? 'visible' : 'none')
  }
}

watch([radius, intensity, useWeight, showPoints], apply)

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
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
      <h4>热力参数</h4>
      <label class="mb-row">
        <span>半径</span>
        <input v-model.number="radius" type="range" min="6" max="60" step="1" />
        <b>{{ radius }}</b>
      </label>
      <label class="mb-row">
        <span>强度</span>
        <input v-model.number="intensity" type="range" min="0.2" max="3" step="0.1" />
        <b>{{ intensity.toFixed(1) }}</b>
      </label>
      <label class="mb-row">
        <input v-model="useWeight" type="checkbox" />
        <span>按 v 字段加权</span>
      </label>
      <label class="mb-row">
        <input v-model="showPoints" type="checkbox" />
        <span>叠加原始散点</span>
      </label>
    </div>
    <div class="mb-tip">2600 个加权点 · 半径与强度随 zoom 插值，放大后自动切成散点</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 226px;
}
.mb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
}
.mb-row input[type='range'] {
  flex: 1;
  accent-color: #4f9dff;
  min-width: 0;
}
.mb-row b {
  width: 26px;
  text-align: right;
  color: #eaf2fb;
  font-variant-numeric: tabular-nums;
}
</style>
