<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import type TileSource from 'ol/source/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Cluster from 'ol/source/Cluster'
import Feature from 'ol/Feature'
import { Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import type { FeatureLike } from 'ol/Feature'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS, DEFAULT_BASEMAP, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
let map: Map | null = null
let baseLayer: TileLayer<TileSource> | null = null

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
}

const CENTER = fromLonLat([111, 31])

function clusterStyle(feature: FeatureLike): Style {
  const feats = feature.get('features') as Feature[] | undefined
  const size = feats ? feats.length : 1

  if (size === 1) {
    return new Style({
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({ color: '#4f9dff' }),
        stroke: new Stroke({ color: '#ffffff', width: 2 }),
      }),
    })
  }

  const radius = Math.min(10 + size, 28)
  return new Style({
    image: new CircleStyle({
      radius,
      fill: new Fill({ color: 'rgba(255, 94, 98, 0.82)' }),
      stroke: new Stroke({ color: '#ffffff', width: 2 }),
    }),
    text: new Text({
      text: String(size),
      font: 'bold 12px sans-serif',
      fill: new Fill({ color: '#ffffff' }),
    }),
  })
}

function zoomBy(delta: number) {
  const view = map?.getView()
  if (!view) return
  view.animate({ zoom: (view.getZoom() ?? 0) + delta, duration: 200 })
}
function reset() {
  map?.getView().animate({ center: CENTER, zoom: 4, duration: 300 })
}
async function toggleFullscreen() {
  const el = wrapRef.value
  if (!el) return
  if (document.fullscreenElement) await document.exitFullscreen()
  else await el.requestFullscreen()
}

onMounted(() => {
  const features: Feature<Point>[] = []
  for (let i = 0; i < 300; i++) {
    const lon = 100 + Math.random() * 22
    const lat = 20 + Math.random() * 22
    features.push(new Feature({ geometry: new Point(fromLonLat([lon, lat])) }))
  }

  const clusterSource = new Cluster({
    distance: 40,
    source: new VectorSource({ features }),
  })

  const clusterLayer = new VectorLayer({
    source: clusterSource,
    style: clusterStyle,
  })

  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })

  map = new Map({
    target: container.value!,
    layers: [baseLayer, clusterLayer],
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
    <div class="tip">共 300 个点：缩小时自动聚合为数字圆点，放大后逐渐展开。</div>
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
