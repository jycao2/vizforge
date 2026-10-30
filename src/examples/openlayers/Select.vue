<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import DragBox from 'ol/interaction/DragBox'
import { shiftKeyOnly } from 'ol/events/condition'
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const total = ref(400)
const selectedCount = ref(0)

let map: Map | null = null
let layer: VectorLayer<Feature> | null = null
let source: VectorSource | null = null
const selected = new Set<Feature>()

const CENTER = fromLonLat([110, 33])

const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, 4.4)
const { current: currentBasemap, create, apply } = useOlBasemap()

const normalStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: new Fill({ color: 'rgba(79, 157, 255, 0.9)' }),
    stroke: new Stroke({ color: 'rgba(255,255,255,0.6)', width: 1 }),
  }),
})
const selectedStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#ff5e62' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
})

onMounted(() => {
  const baseLayer = create()
  const features: Feature[] = []
  for (let i = 0; i < total.value; i++) {
    const lon = 92 + Math.random() * 40
    const lat = 18 + Math.random() * 30
    features.push(new Feature({ geometry: new Point(fromLonLat([lon, lat])) }))
  }

  const src = new VectorSource({ features })
  source = src
  const vLayer = new VectorLayer({
    source: src,
    style: (f) => (selected.has(f as Feature) ? selectedStyle : normalStyle),
  })
  layer = vLayer

  map = new Map({
    target: container.value!,
    layers: [baseLayer, vLayer],
    view: new View({ center: CENTER, zoom: 4.4 }),
  })

  // Shift + 拖拽框选
  const dragBox = new DragBox({ condition: shiftKeyOnly })
  map.addInteraction(dragBox)

  dragBox.on('boxend', () => {
    const extent = dragBox.getGeometry().getExtent()
    src.forEachFeatureIntersectingExtent(extent, (f) => {
      selected.add(f as Feature)
    })
    selectedCount.value = selected.size
    vLayer.changed()
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
  layer = null
  source = null
})

function clearSelection() {
  selected.clear()
  selectedCount.value = 0
  layer?.changed()
}

function reseed() {
  if (!source || !layer) return
  selected.clear()
  selectedCount.value = 0
  const features: Feature[] = []
  for (let i = 0; i < total.value; i++) {
    const lon = 92 + Math.random() * 40
    const lat = 18 + Math.random() * 30
    features.push(new Feature({ geometry: new Point(fromLonLat([lon, lat])) }))
  }
  source.clear()
  source.addFeatures(features)
  layer.changed()
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
        <span class="stat">点总数 <b>{{ total }}</b></span>
        <span class="stat">已选中 <b class="hl">{{ selectedCount }}</b></span>
      </div>
      <div class="row">
        <button class="btn" @click="clearSelection">清除选择</button>
        <button class="btn" @click="reseed">重新生成</button>
      </div>
      <div class="tip">按住 Shift 在地图上拖出矩形框，框内要素会被选中并高亮（DragBox + forEachFeatureIntersectingExtent）。</div>
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
  gap: 10px;
  align-items: center;
}
.row + .row {
  margin-top: 8px;
}
.stat {
  font-size: 12px;
  color: #8b9aab;
}
.stat b {
  color: #e6eef7;
}
.stat b.hl {
  color: #ff5e62;
}
.btn {
  flex: 1;
  padding: 5px 0;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: transparent;
  color: #c3cfdb;
  font-size: 12px;
  cursor: pointer;
}
.btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
