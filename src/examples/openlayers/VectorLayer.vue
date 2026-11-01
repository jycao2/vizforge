<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import type TileSource from 'ol/source/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { Style, Circle as CircleStyle, Fill, Stroke } from 'ol/style'
import MapControls from '@/components/MapControls.vue'
import { useOlHost } from './useOl'
import { OL_BASEMAPS, DEFAULT_BASEMAP, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
let map: Map | null = null

useOlHost(() => map)

let baseLayer: TileLayer<TileSource> | null = null

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
}

const CENTER = fromLonLat([111, 31])

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
  const features: Feature[] = []
  for (let i = 0; i < 40; i++) {
    const lon = 100 + Math.random() * 22
    const lat = 20 + Math.random() * 22
    const f = new Feature({ geometry: new Point(fromLonLat([lon, lat])) })
    features.push(f)
  }

  const style = new Style({
    image: new CircleStyle({
      radius: 6,
      fill: new Fill({ color: '#ff5e62' }),
      stroke: new Stroke({ color: '#ffffff', width: 2 }),
    }),
  })

  const vectorLayer = new VectorLayer({
    source: new VectorSource({ features }),
    style,
  })

  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })

  map = new Map({
    target: container.value!,
    layers: [baseLayer, vectorLayer],
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
</style>
