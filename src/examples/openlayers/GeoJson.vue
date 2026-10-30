<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import GeoJSON from 'ol/format/GeoJSON'
import { fromLonLat } from 'ol/proj'
import { Fill, Stroke, Style } from 'ol/style'
import type Feature from 'ol/Feature'
import type { FeatureLike } from 'ol/Feature'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const status = ref('正在加载 GeoJSON…')
const selectedName = ref('—')
const featureCount = ref(0)

let map: Map | null = null
let vectorLayer: VectorLayer<Feature> | null = null
let selected: FeatureLike | null = null
let source: VectorSource | null = null

const CENTER = fromLonLat([104, 35])
const GEOJSON_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json'

const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, 4.2)
const { current: currentBasemap, create, apply } = useOlBasemap()

const baseStyle = new Style({
  fill: new Fill({ color: 'rgba(79, 157, 255, 0.28)' }),
  stroke: new Stroke({ color: 'rgba(126, 231, 135, 0.95)', width: 1.4 }),
})
const activeStyle = new Style({
  fill: new Fill({ color: 'rgba(255, 166, 87, 0.42)' }),
  stroke: new Stroke({ color: '#ffa657', width: 2.2 }),
})

onMounted(async () => {
  const baseLayer = create()
  const src = new VectorSource()
  source = src
  const vLayer = new VectorLayer({
    source: src,
    style: (f) => (f === selected ? activeStyle : baseStyle),
  })
  vectorLayer = vLayer

  map = new Map({
    target: container.value!,
    layers: [baseLayer, vLayer],
    view: new View({ center: CENTER, zoom: 4.2 }),
  })

  map.on('singleclick', (evt) => {
    if (!map) return
    let hit: FeatureLike | null = null
    map.forEachFeatureAtPixel(evt.pixel, (f) => {
      hit = f
      return true
    })
    selected = hit
    vLayer.changed()
    const name = hit ? ((hit as Feature).get('name') as string | undefined) : undefined
    selectedName.value = name || '—'
  })

  try {
    const res = await fetch(GEOJSON_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' })
    src.addFeatures(features)
    featureCount.value = features.length
    status.value = `已加载 ${features.length} 个省级行政区，点击可高亮`
  } catch (e) {
    status.value = 'GeoJSON 加载失败：' + String(e)
  }
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
  vectorLayer = null
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
        <span class="k">要素</span><span class="v">{{ featureCount }}</span>
        <span class="k">选中</span><span class="v hl">{{ selectedName }}</span>
      </div>
      <div class="tip">{{ status }}</div>
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
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 12px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.k {
  color: #8b9aab;
}
.v {
  color: #e6eef7;
  margin-right: 10px;
}
.v.hl {
  color: #ffa657;
  font-weight: 600;
}
.tip {
  margin-top: 6px;
  color: #8b9aab;
  font-size: 11.5px;
}
</style>
