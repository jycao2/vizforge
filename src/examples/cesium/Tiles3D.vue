<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const info = ref('正在加载 3D Tiles…')
let viewer: Cesium.Viewer | null = null
let tileset: Cesium.Cesium3DTileset | null = null
let destroyed = false

// 该 tileset 位于费城，region 换算后约为 (-75.611, 40.042)
const home = {
  destination: Cesium.Cartesian3.fromDegrees(-75.6113, 40.042, 260),
  orientation: {
    heading: Cesium.Math.toRadians(20),
    pitch: Cesium.Math.toRadians(-32),
    roll: 0,
  },
  // 给了 focus：复位与缩放都锚在这块瓦片集上，不会把它推出画面
  focus: {
    center: Cesium.Cartesian3.fromDegrees(-75.6113, 40.042, 30),
    radius: 90,
    range: 520,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer)

onMounted(async () => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)

  try {
    tileset = await Cesium.Cesium3DTileset.fromUrl('/3dtiles/tileset/tileset.json', {
      maximumScreenSpaceError: 8,
    })
    if (destroyed || !viewer) {
      tileset.destroy()
      return
    }
    // 按建筑高度分色，直观看出 LOD 分块
    tileset.style = new Cesium.Cesium3DTileStyle({
      color: {
        conditions: [
          ['${Height} > 70', "color('#ff7b72')"],
          ['${Height} > 30', "color('#ffd166')"],
          ['true', "color('#4ecdc4')"],
        ],
      },
    })
    viewer.scene.primitives.add(tileset)
    await viewer.zoomTo(tileset, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-32), 300))
    info.value = '3D Tiles 已加载：按高度着色（青 → 黄 → 红 表示低到高）'
  } catch (e) {
    info.value = '3D Tiles 加载失败：' + String(e)
  }
})

onBeforeUnmount(() => {
  destroyed = true
  viewer?.destroy()
  viewer = null
  tileset = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>
    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="tip">{{ info }}</div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.cesium-container {
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
  font-size: 12.5px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}
</style>
