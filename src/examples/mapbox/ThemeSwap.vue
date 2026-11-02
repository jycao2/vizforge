<script setup lang="ts">
/**
 * 底图风格化（raster 滤镜）
 * ===========================================================================
 * 同一份影像底图，改几个 raster 的 paint 参数就能出完全不同的调性 ——
 * 这比准备多套底图服务省事得多，也是 Mapbox 排版里最实用的一组属性：
 *
 *  | 属性                       | 作用                                |
 *  |---------------------------|------------------------------------|
 *  | raster-brightness-min/max | 把动态范围压到 [min,max]，提亮/压暗 |
 *  | raster-saturation         | 饱和度，−1 全灰，+1 高饱和          |
 *  | raster-contrast           | 对比度                              |
 *  | raster-hue-rotate         | 色相旋转（度）                      |
 *  | raster-opacity            | 与背景色的混合                      |
 *
 * 数据可视化的经验值：底图不要抢数据的注意力，通常降饱和 + 压暗 + 偏冷，
 * 让彩色数据点浮在上面；打印/导出场景再切回原色。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { CITIES, fc, feat } from './data'
import { rasterStyle } from './basemaps'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const HOME = { center: [120.15, 30.26] as [number, number], zoom: 11 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

interface Theme {
  id: string
  label: string
  bg: string
  min: number
  max: number
  sat: number
  con: number
  hue: number
  op: number
}

const THEMES: Theme[] = [
  { id: 'raw', label: '原色', bg: '#0a121c', min: 0, max: 1, sat: 0, con: 0, hue: 0, op: 1 },
  { id: 'deep', label: '深海蓝', bg: '#061020', min: 0.06, max: 0.72, sat: -0.35, con: 0.12, hue: 190, op: 0.92 },
  { id: 'mono', label: '黑白', bg: '#000000', min: 0.05, max: 0.85, sat: -1, con: 0.28, hue: 0, op: 1 },
  { id: 'retro', label: '复古', bg: '#1a1206', min: 0.1, max: 0.9, sat: 0.35, con: 0.18, hue: 28, op: 0.95 },
  { id: 'cold', label: '冷调', bg: '#08131f', min: 0.08, max: 0.8, sat: -0.2, con: 0.22, hue: 205, op: 1 },
  { id: 'warm', label: '暖阳', bg: '#1d1204', min: 0.12, max: 0.95, sat: 0.42, con: 0.1, hue: 320, op: 1 },
]

const active = ref('deep')

function apply(t: Theme) {
  if (!map) return
  active.value = t.id
  map.setPaintProperty('base', 'raster-brightness-min', t.min)
  map.setPaintProperty('base', 'raster-brightness-max', t.max)
  map.setPaintProperty('base', 'raster-saturation', t.sat)
  map.setPaintProperty('base', 'raster-contrast', t.con)
  map.setPaintProperty('base', 'raster-hue-rotate', t.hue)
  map.setPaintProperty('base', 'raster-opacity', t.op)
  map.setPaintProperty('bg', 'background-color', t.bg)
}

function build() {
  if (!map) return
  apply(THEMES.find((t) => t.id === active.value)!)
  // 一层数据压在底图上，用来检验"底图有没有抢注意力"
  map.addSource('cities', {
    type: 'geojson',
    data: fc(CITIES.map((c) => feat({ type: 'Point', coordinates: c.c }, { name: c.name, v: c.v }))),
  })
  map.addLayer({
    id: 'cities',
    type: 'circle',
    source: 'cities',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'v'], 20, 3, 100, 10],
      'circle-color': '#ffd166',
      'circle-opacity': 0.92,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(8,14,22,0.7)',
    },
  })
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME, style: rasterStyle('imagery') })
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
      <h4>底图风格</h4>
      <div class="grid">
        <button
          v-for="t in THEMES"
          :key="t.id"
          class="mb-btn"
          :class="{ on: active === t.id }"
          @click="apply(t)"
        >
          {{ t.label }}
        </button>
      </div>
      <div class="hint">只改 raster 的 5 个 paint 参数，不换底图服务</div>
    </div>
    <div class="mb-tip">影像底图 + 风格化滤镜 · 数据层始终压在底图之上</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 212px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 5px;
}
.hint {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
