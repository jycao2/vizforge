<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import TileWMS from 'ol/source/TileWMS'
import { fromLonLat } from 'ol/proj'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

interface WmsOption {
  id: string
  label: string
  layer: string
  desc: string
}

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const opacity = ref(0.9)

let map: Map | null = null
let wmsLayer: TileLayer<TileWMS> | null = null

const CENTER = fromLonLat([110, 32])

const options: WmsOption[] = [
  {
    id: 'viirs',
    label: '真彩色',
    layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    desc: 'VIIRS 每日真彩色影像（NASA GIBS）',
  },
  {
    id: 'modis',
    label: 'MODIS',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    desc: 'MODIS Terra 真彩色合成',
  },
  {
    id: 'temp',
    label: '地表温度',
    layer: 'MODIS_Terra_Land_Surface_Temp_Day',
    desc: 'MODIS 白天地表温度（伪彩色）',
  },
]
const current = ref(options[0])

const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, 3.4)
const { current: currentBasemap, create, apply } = useOlBasemap()

function createWmsSource(layer: string): TileWMS {
  return new TileWMS({
    url: 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi',
    params: { LAYERS: layer, TILED: true, VERSION: '1.1.1' },
    crossOrigin: 'anonymous',
  })
}

function switchLayer(opt: WmsOption) {
  current.value = opt
  wmsLayer?.setSource(createWmsSource(opt.layer))
}

onMounted(() => {
  const baseLayer = create()
  wmsLayer = new TileLayer({
    source: createWmsSource(current.value.layer),
    opacity: opacity.value,
  })

  map = new Map({
    target: container.value!,
    layers: [baseLayer, wmsLayer],
    view: new View({ center: CENTER, zoom: 3.4 }),
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
  wmsLayer = null
})

function onOpacityInput(v: number) {
  opacity.value = v
  wmsLayer?.setOpacity(v)
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
        <button
          v-for="opt in options"
          :key="opt.id"
          class="btn"
          :class="{ on: opt.id === current.id }"
          @click="switchLayer(opt)"
        >
          {{ opt.label }}
        </button>
      </div>
      <div class="row second">
        <span class="label">透明度</span>
        <input
          class="range"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="opacity"
          @input="onOpacityInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ Math.round(opacity * 100) }}%</span>
      </div>
      <div class="tip">TileWMS 图层叠加在底图之上：{{ current.desc }}</div>
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
  width: 310px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  gap: 6px;
}
.row.second {
  margin-top: 8px;
  align-items: center;
  gap: 8px;
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
.btn.on {
  background: #4f9dff;
  border-color: #4f9dff;
  color: #fff;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 38px;
  text-align: right;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
