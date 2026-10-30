<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { createCesiumImagery, DEFAULT_BASEMAP } from './basemaps'

const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null
let timer: number | undefined
let index = 0

interface City {
  name: string
  lon: number
  lat: number
}

const cities: City[] = [
  { name: '北京', lon: 116.391, lat: 39.907 },
  { name: '纽约', lon: -74.006, lat: 40.7128 },
  { name: '巴黎', lon: 2.3522, lat: 48.8566 },
  { name: '东京', lon: 139.6917, lat: 35.6895 },
  { name: '悉尼', lon: 151.2093, lat: -33.8688 },
]

function fly() {
  if (!viewer) return
  const c = cities[index % cities.length]
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 1600000),
    duration: 2.2,
    complete: () => {
      index += 1
      timer = window.setTimeout(fly, 1400)
    },
  })
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, {
    baseLayer: new Cesium.ImageryLayer(createCesiumImagery(DEFAULT_BASEMAP)),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  })

  for (const c of cities) {
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
      point: { pixelSize: 10, color: Cesium.Color.ORANGE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
      label: {
        text: c.name,
        font: '14px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -22),
        fillColor: Cesium.Color.WHITE,
      },
    })
  }

  fly()
})

onBeforeUnmount(() => {
  if (timer) window.clearTimeout(timer)
  viewer?.destroy()
  viewer = null
})
</script>

<template>
  <div ref="container" class="cesium-container"></div>
</template>

<style scoped>
.cesium-container {
  width: 100%;
  height: 100%;
}
</style>
