<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { LineString, Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { defaults as defaultControls } from 'ol/control'
import OverviewMap from 'ol/control/OverviewMap'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import MapControls from '@/components/MapControls.vue'
import type TileSource from 'ol/source/Tile'
import { OL_BASEMAPS, createOlSource } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: Map | null = null
let overviewLayer: TileLayer<TileSource> | null = null

const { current: currentBasemap, create: createBasemap, apply: applyBasemap } = useOlBasemap()
const HOME = fromLonLat([106, 33])
const homeZoom = 4
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, HOME, homeZoom)

const CITIES: { name: string; lon: number; lat: number }[] = [
  { name: '北京', lon: 116.391, lat: 39.907 },
  { name: '西安', lon: 108.948, lat: 34.263 },
  { name: '成都', lon: 104.066, lat: 30.572 },
  { name: '昆明', lon: 102.833, lat: 24.88 },
  { name: '广州', lon: 113.264, lat: 23.129 },
  { name: '上海', lon: 121.474, lat: 31.23 },
]

onMounted(() => {
  const routeCoords = [...CITIES, CITIES[0]].map((c) => fromLonLat([c.lon, c.lat]))

  const routeSource = new VectorSource({
    features: [
      new Feature({ geometry: new LineString(routeCoords) }),
      ...CITIES.map(
        (c) => new Feature({ geometry: new Point(fromLonLat([c.lon, c.lat])), name: c.name }),
      ),
    ],
  })

  const routeLayer = new VectorLayer({
    source: routeSource,
    declutter: true,
    style: (feature) => {
      const geom = feature.getGeometry()
      if (geom instanceof LineString) {
        return new Style({
          stroke: new Stroke({ color: 'rgba(79,157,255,0.95)', width: 2.4, lineDash: [10, 8] }),
        })
      }
      return new Style({
        image: new CircleStyle({
          radius: 5.5,
          fill: new Fill({ color: '#ffc46b' }),
          stroke: new Stroke({ color: '#0b1220', width: 2 }),
        }),
        text: new Text({
          text: (feature.get('name') as string) ?? '',
          offsetY: -16,
          font: '600 11px sans-serif',
          fill: new Fill({ color: '#fff' }),
          stroke: new Stroke({ color: 'rgba(6,10,16,0.9)', width: 3 }),
        }),
      })
    },
  })

  const mainBase = createBasemap()

  // 鹰眼图用独立的一套瓦片图层：同一个图层实例不能挂到两个地图上
  overviewLayer = new TileLayer({ source: createOlSource(currentBasemap.value) })
  const overview = new OverviewMap({
    className: 'ol-overviewmap overview-dark',
    collapsed: false,
    collapsible: false,
    layers: [overviewLayer],
    rotateWithView: true,
  })

  map = new Map({
    target: container.value!,
    layers: [mainBase, routeLayer],
    view: new View({ center: HOME, zoom: homeZoom, minZoom: 3, maxZoom: 16 }),
    controls: defaultControls({ zoom: false, rotate: false, attribution: false }).extend([overview]),
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
  overviewLayer = null
})

/** 切换底图时同步鹰眼图，避免两套视觉风格不一致 */
function setBasemap(id: string) {
  applyBasemap(id)
  overviewLayer?.setSource(createOlSource(id))
}
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
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="tip">
      右下角是 OverviewMap 鹰眼图：小地图上的红框表示主图当前可视范围，拖动红框可快速定位。
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

/* 鹰眼图外观（控件 DOM 由 OL 创建，需 :deep 命中） */
:deep(.overview-dark) {
  /* 必须清掉 ol.css 里的 left: .5em，否则 left+right 同时生效会把控件拉满整行 */
  left: auto;
  right: 14px;
  bottom: 14px;
  border: 1px solid rgba(90, 110, 135, 0.6);
  border-radius: 10px;
  overflow: hidden;
  background: rgba(12, 18, 26, 0.9);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4);
}
:deep(.overview-dark .ol-overviewmap-map) {
  width: 200px;
  height: 156px;
  border: 0;
}
:deep(.overview-dark .ol-overviewmap-box) {
  border: 2px solid #ff5a5f;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
}
</style>
