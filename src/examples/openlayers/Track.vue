<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { LineString, Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { getLength } from 'ol/sphere'
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const playing = ref(true)
const speed = ref(1)
const progress = ref(0)
const traveledText = ref('0.00 km')

let map: Map | null = null
let raf = 0
let lastTs = 0
let t = 0 // 0~1 行进比例

const ROUTE_LONLAT: [number, number][] = [
  [116.204, 39.905],
  [116.28, 39.92],
  [116.33, 39.945],
  [116.391, 39.907],
  [116.43, 39.9],
  [116.47, 39.885],
  [116.52, 39.9],
  [116.58, 39.92],
]
const coords = ROUTE_LONLAT.map(([lon, lat]) => fromLonLat([lon, lat]))
const routeGeom = new LineString(coords)

// 累计长度（米），用于计算已行驶距离
const cumulative: number[] = [0]
for (let i = 1; i < coords.length; i++) {
  const seg = new LineString([coords[i - 1], coords[i]])
  cumulative.push(cumulative[i - 1] + getLength(seg))
}
const totalLength = cumulative[cumulative.length - 1]

const CENTER = fromLonLat([116.39, 39.91])

const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, 11)
const { current: currentBasemap, create, apply } = useOlBasemap()

let routeFeature: Feature<LineString> | null = null
let passedFeature: Feature<LineString> | null = null
let markerFeature: Feature<Point> | null = null
let source: VectorSource | null = null

const routeStyle = new Style({
  stroke: new Stroke({ color: 'rgba(79, 157, 255, 0.55)', width: 4, lineDash: [8, 8] }),
})
const passedStyle = new Style({
  stroke: new Stroke({ color: '#7ee787', width: 5 }),
})
const markerStyle = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: '#ff5e62' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
})

function distanceAt(fraction: number): number {
  return Math.min(1, Math.max(0, fraction)) * totalLength
}

function updateGeometry() {
  if (!routeFeature || !passedFeature || !markerFeature) return
  const fraction = t
  const point = routeGeom.getCoordinateAt(fraction)

  // 已经过的路径
  const passedCoords: number[][] = []
  const targetLen = fraction * totalLength
  passedCoords.push(coords[0])
  for (let i = 1; i < coords.length; i++) {
    if (cumulative[i] <= targetLen) {
      passedCoords.push(coords[i])
    } else {
      passedCoords.push(point)
      break
    }
  }
  if (passedCoords.length < 2) passedCoords.push(point)
  passedFeature.getGeometry()?.setCoordinates(passedCoords)
  markerFeature.getGeometry()?.setCoordinates(point)

  progress.value = fraction * 100
  traveledText.value = (distanceAt(fraction) / 1000).toFixed(2) + ' km'
}

onMounted(() => {
  const baseLayer = create()

  routeFeature = new Feature({ geometry: routeGeom.clone() })
  routeFeature.setStyle(routeStyle)

  passedFeature = new Feature({ geometry: new LineString([coords[0], coords[0]]) })
  passedFeature.setStyle(passedStyle)

  markerFeature = new Feature({ geometry: new Point(coords[0]) })
  markerFeature.setStyle(markerStyle)

  const features: Feature[] = [routeFeature, passedFeature, markerFeature]
  source = new VectorSource({ features })
  const layer = new VectorLayer({ source })

  map = new Map({
    target: container.value!,
    layers: [baseLayer, layer],
    view: new View({ center: CENTER, zoom: 11 }),
  })

  updateGeometry()

  const loop = (ts: number) => {
    raf = requestAnimationFrame(loop)
    if (!lastTs) lastTs = ts
    const dt = (ts - lastTs) / 1000
    lastTs = ts
    if (!playing.value) return
    // 全程约 24 秒播放完
    t += (dt * speed.value) / 24
    if (t > 1) t = 0
    updateGeometry()
  }
  raf = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  map?.setTarget(undefined)
  map = null
  source = null
})

function togglePlay() {
  playing.value = !playing.value
}
function cycleSpeed() {
  speed.value = speed.value === 1 ? 2 : speed.value === 2 ? 4 : 1
}
function restart() {
  t = 0
  updateGeometry()
}
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>
    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="apply"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="panel">
      <div class="row">
        <button class="btn primary" @click="togglePlay">{{ playing ? '暂停' : '播放' }}</button>
        <button class="btn" @click="cycleSpeed">{{ speed }}× 速度</button>
        <button class="btn" @click="restart">重播</button>
      </div>
      <div class="bar">
        <div class="bar-inner" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="row stats">
        <span>已行驶 <b>{{ traveledText }}</b></span>
        <span>全程 <b>{{ (totalLength / 1000).toFixed(2) }} km</b></span>
      </div>
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
  width: 330px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.btn {
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
.btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
.btn.primary {
  background: #4f9dff;
  border-color: #4f9dff;
  color: #fff;
}
.bar {
  margin: 9px 0;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}
.bar-inner {
  height: 100%;
  background: linear-gradient(90deg, #4f9dff, #7ee787);
}
.stats {
  font-size: 12px;
  color: #8b9aab;
  gap: 14px;
}
.stats b {
  color: #7ee787;
}
</style>
