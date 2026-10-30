<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import type TileSource from 'ol/source/Tile'
import { fromLonLat } from 'ol/proj'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS, DEFAULT_BASEMAP, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
let map: Map | null = null
let baseLayer: TileLayer<TileSource> | null = null

const CENTER = fromLonLat([116.391, 39.907])

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
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
  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })
  map = new Map({
    target: container.value!,
    layers: [baseLayer],
    view: new View({ center: CENTER, zoom: 4 }),
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
  baseLayer = null
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
