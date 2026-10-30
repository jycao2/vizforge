<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import type TileSource from 'ol/source/Tile'
import Heatmap from 'ol/layer/Heatmap'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import type { FeatureLike } from 'ol/Feature'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
// 热力图默认配深色底图，对比更强
const currentBasemap = ref('dark')
let map: Map | null = null
let baseLayer: TileLayer<TileSource> | null = null

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
}

const CENTER = fromLonLat([116.391, 39.907])

function zoomBy(delta: number) {
  const view = map?.getView()
  if (!view) return
  view.animate({ zoom: (view.getZoom() ?? 0) + delta, duration: 200 })
}
function reset() {
  map?.getView().animate({ center: CENTER, zoom: 5, duration: 300 })
}
async function toggleFullscreen() {
  const el = wrapRef.value
  if (!el) return
  if (document.fullscreenElement) await document.exitFullscreen()
  else await el.requestFullscreen()
}

onMounted(() => {
  const features: Feature<Point>[] = []
  for (let i = 0; i < 600; i++) {
    // 用若干高斯热点叠加，让热力图更有层次
    const hot = i % 3
    const cx = [116.391, 121.47, 113.26][hot]
    const cy = [39.907, 31.23, 23.13][hot]
    const lon = cx + (Math.random() - 0.5) * 3
    const lat = cy + (Math.random() - 0.5) * 3
    features.push(
      new Feature({
        geometry: new Point(fromLonLat([lon, lat])),
        weight: 0.3 + Math.random() * 0.7,
      }),
    )
  }

  const heatLayer = new Heatmap({
    source: new VectorSource({ features }),
    blur: 16,
    radius: 6,
    weight: (feature: FeatureLike) => (feature.get('weight') as number) ?? 1,
  })

  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })

  map = new Map({
    target: container.value!,
    layers: [baseLayer, heatLayer],
    view: new View({ center: CENTER, zoom: 4 }),
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
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
      @fullscreen="toggleFullscreen"
    />
    <div class="tip">600 个加权点生成的热力图，叠加在深色底图上。</div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.ol-container {
  width: 100%;
  height: 100%;
}
.tip {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 12px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}
</style>
