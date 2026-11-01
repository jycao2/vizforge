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
import type { Map as OlMap, MapEvent } from 'ol'
import type { FeatureLike } from 'ol/Feature'
import MapControls from '@/components/MapControls.vue'
import { useOlHost } from './useOl'
import { OL_BASEMAPS, DEFAULT_BASEMAP, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
let map: OlMap | null = null

useOlHost(() => map)

let baseLayer: TileLayer<TileSource> | null = null
let markerLayer: VectorLayer<Feature<Point>> | undefined

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
}

const CENTER = fromLonLat([116.391, 39.907])

let radius = 8
let delta = 0.12
let style: Style

function createStyle(): Style {
  return new Style({
    image: new CircleStyle({
      radius,
      fill: new Fill({ color: 'rgba(255, 94, 98, 0.55)' }),
      stroke: new Stroke({ color: '#ffffff', width: 2 }),
    }),
  })
}

function onPostRender() {
  radius += delta
  if (radius > 22 || radius < 8) delta = -delta
  if (markerLayer) {
    style = createStyle()
    markerLayer.changed()
  }
  map?.render()
}

function zoomBy(deltaZoom: number) {
  const view = map?.getView()
  if (!view) return
  view.animate({ zoom: (view.getZoom() ?? 0) + deltaZoom, duration: 200 })
}
function reset() {
  map?.getView().animate({ center: CENTER, zoom: 6, duration: 300 })
}
async function toggleFullscreen() {
  const el = wrapRef.value
  if (!el) return
  if (document.fullscreenElement) await document.exitFullscreen()
  else await el.requestFullscreen()
}

onMounted(() => {
  style = createStyle()
  const marker = new Feature({ geometry: new Point(CENTER) })

  const vlayer = new VectorLayer<Feature<Point>>({
    source: new VectorSource({ features: [marker] }),
    style: (feature: FeatureLike) => (feature === marker ? style : createStyle()),
  })
  markerLayer = vlayer

  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })

  map = new Map({
    target: container.value!,
    layers: [baseLayer, vlayer],
    view: new View({ center: CENTER, zoom: 6 }),
  })

  map.on('postrender', onPostRender)
})

onBeforeUnmount(() => {
  if (map) map.un('postrender', onPostRender)
  map?.setTarget(undefined)
  map = null
  markerLayer = undefined
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
