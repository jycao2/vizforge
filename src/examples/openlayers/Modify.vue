<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { LineString, Polygon } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import Modify from 'ol/interaction/Modify'
import Snap from 'ol/interaction/Snap'
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const tip = ref('拖动顶点即可修改几何，靠近其他要素时会自动吸附')

let map: Map | null = null
let source: VectorSource | null = null

const CENTER = fromLonLat([116.391, 39.907])

const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, 12)
const { current: currentBasemap, create, apply } = useOlBasemap()

const editStyle = new Style({
  fill: new Fill({ color: 'rgba(79, 157, 255, 0.22)' }),
  stroke: new Stroke({ color: '#4f9dff', width: 2 }),
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#ffa657' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
})

function seed() {
  if (!source) return
  source.clear()
  const p1 = new Feature(
    new Polygon([
      [
        fromLonLat([116.34, 39.93]),
        fromLonLat([116.4, 39.93]),
        fromLonLat([116.4, 39.97]),
        fromLonLat([116.34, 39.97]),
        fromLonLat([116.34, 39.93]),
      ],
    ]),
  )
  const p2 = new Feature(
    new Polygon([
      [
        fromLonLat([116.42, 39.88]),
        fromLonLat([116.47, 39.88]),
        fromLonLat([116.47, 39.92]),
        fromLonLat([116.42, 39.92]),
        fromLonLat([116.42, 39.88]),
      ],
    ]),
  )
  const line = new Feature(
    new LineString([
      fromLonLat([116.33, 39.88]),
      fromLonLat([116.4, 39.9]),
      fromLonLat([116.46, 39.86]),
    ]),
  )
  source.addFeatures([p1, p2, line])
}

onMounted(() => {
  const baseLayer = create()
  source = new VectorSource({ wrapX: false })
  const vectorLayer = new VectorLayer({ source, style: editStyle })

  map = new Map({
    target: container.value!,
    layers: [baseLayer, vectorLayer],
    view: new View({ center: CENTER, zoom: 12 }),
  })

  seed()

  // 顶点编辑 + 顶点吸附
  map.addInteraction(new Modify({ source, pixelTolerance: 8 }))
  map.addInteraction(new Snap({ source }))
})

onBeforeUnmount(() => {
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
      @update:model-value="apply"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="panel">
      <div class="row">
        <span class="tip">{{ tip }}</span>
        <button class="btn" @click="seed">重置图形</button>
      </div>
      <div class="hint">Modify + Snap：拖拽节点或边线中点修改几何，红色/蓝色图形会互相吸附。</div>
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
  width: 340px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tip {
  flex: 1;
  font-size: 12px;
  color: #c3cfdb;
  line-height: 1.5;
}
.btn {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: transparent;
  color: #c3cfdb;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
.hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
