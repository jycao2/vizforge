<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import type TileSource from 'ol/source/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Draw from 'ol/interaction/Draw'
import { fromLonLat } from 'ol/proj'
import { getArea, getLength } from 'ol/sphere'
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style'
import type { DrawEvent } from 'ol/interaction/Draw'
import MapControls from '@/components/MapControls.vue'
import { useOlHost } from './useOl'
import { OL_BASEMAPS, DEFAULT_BASEMAP, createOlSource, applyOlBasemap } from './basemaps'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
const results = ref<string[]>([])
const activeTool = ref<'' | 'LineString' | 'Polygon'>('')
let map: Map | null = null

useOlHost(() => map)

let baseLayer: TileLayer<TileSource> | null = null
let draw: Draw | null = null
let source: VectorSource | null = null

function setBasemap(id: string) {
  applyOlBasemap(baseLayer, id)
  currentBasemap.value = id
}

const CENTER = fromLonLat([116.391, 39.907])

const drawStyle = new Style({
  stroke: new Stroke({ color: '#ff5e62', width: 2.5 }),
  fill: new Fill({ color: 'rgba(255, 94, 98, 0.18)' }),
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: '#ff5e62' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
})

function formatLength(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(1)} m`
}
function formatArea(sqMeters: number) {
  return sqMeters >= 1e6 ? `${(sqMeters / 1e6).toFixed(2)} km²` : `${sqMeters.toFixed(1)} m²`
}

function stopDraw() {
  if (map && draw) map.removeInteraction(draw)
  draw = null
  activeTool.value = ''
}

function startDraw(type: 'LineString' | 'Polygon') {
  if (!map || !source) return
  stopDraw()
  activeTool.value = type
  draw = new Draw({ source, type, style: drawStyle })
  draw.on('drawend', (evt: DrawEvent) => {
    const geom = evt.feature.getGeometry()
    if (!geom) return
    if (type === 'LineString') {
      const len = getLength(geom, { projection: 'EPSG:3857' })
      results.value.unshift(`测量长度：${formatLength(len)}`)
    } else {
      const area = getArea(geom, { projection: 'EPSG:3857' })
      results.value.unshift(`测量面积：${formatArea(area)}`)
    }
    stopDraw()
  })
  map.addInteraction(draw)
}

function clearAll() {
  source?.clear()
  results.value = []
  stopDraw()
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
  source = new VectorSource()
  const vectorLayer = new VectorLayer({ source, style: drawStyle })
  baseLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })
  map = new Map({
    target: container.value!,
    layers: [baseLayer, vectorLayer],
    view: new View({ center: CENTER, zoom: 4 }),
  })
})

onBeforeUnmount(() => {
  stopDraw()
  map?.setTarget(undefined)
  map = null
  source = null
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
    <div class="panel">
      <div class="tools">
        <button class="tool-btn" :class="{ active: activeTool === 'LineString' }" @click="startDraw('LineString')">
          测距
        </button>
        <button class="tool-btn" :class="{ active: activeTool === 'Polygon' }" @click="startDraw('Polygon')">
          测面
        </button>
        <button class="tool-btn" @click="clearAll">清除</button>
      </div>
      <div v-if="results.length" class="results">
        <div v-for="(r, i) in results" :key="i" class="result-item">{{ r }}</div>
      </div>
      <div v-else class="tip">选择「测距」或「测面」，在地图上单击绘制，双击结束。</div>
    </div>
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
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 270px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 13px;
  backdrop-filter: blur(8px);
}
.tools {
  display: flex;
  gap: 8px;
}
.tool-btn {
  flex: 1;
  padding: 6px 0;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: transparent;
  color: #c3cfdb;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.tool-btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
.tool-btn.active {
  background: #4f9dff;
  border-color: #4f9dff;
  color: #fff;
}
.results {
  margin-top: 10px;
  max-height: 140px;
  overflow-y: auto;
}
.result-item {
  padding: 4px 0;
  border-top: 1px solid rgba(90, 110, 135, 0.25);
  font-size: 12px;
  color: #7ee787;
}
.tip {
  margin-top: 10px;
  font-size: 12px;
  color: #8b9aab;
  line-height: 1.5;
}
</style>
