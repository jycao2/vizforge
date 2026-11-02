<script setup lang="ts">
/**
 * 基础地图
 * ===========================================================================
 * 整个 Mapbox 分类的门面示例，把后面 29 个例子都会用到的三件事讲清楚：
 *
 *  1) 免 Token 跑起来：Mapbox GL 只在请求 mapbox:// 资源时校验 accessToken，
 *     本项目所有 source 都是普通 https 瓦片 + 内联 GeoJSON，所以不配 Token 也能用。
 *     底图用 rasterStyle() 现拼一个合法 style（见 basemaps.ts）。
 *  2) 工具栏：放大 / 缩小 / 复位 / 全屏 + 五套 Esri 底图切换，走 MapControls。
 *  3) 视图状态：move 事件里读 center / zoom / bearing / pitch，右下角实时显示。
 *
 * 换底图要注意：setStyle() 会清空之前 addLayer 的东西，所以凡是有业务图层的示例，
 * 都必须像 setBasemap 这样「换完 style 再重挂」（onStyleReady / swapBasemap 已封装）。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_BASEMAPS, rasterStyle } from './basemaps'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const current = ref('dark')
const readout = ref('')
let map: MbMap | null = null

const HOME = { center: [120.15, 30.27] as [number, number], zoom: 11 }

const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

function setBasemap(id: string) {
  if (!map) return
  // 本例没有业务图层，直接换就行；有图层的示例要在 style.load 后重挂
  map.setStyle(rasterStyle(id))
  current.value = id
}

function syncReadout() {
  if (!map) return
  const c = map.getCenter()
  readout.value =
    `${c.lng.toFixed(4)}°, ${c.lat.toFixed(4)}° · z${map.getZoom().toFixed(2)}` +
    ` · 方位 ${map.getBearing().toFixed(0)}° · 倾角 ${map.getPitch().toFixed(0)}°`
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME, style: current.value })
  map!.on('move', syncReadout)
  map!.on('load', syncReadout)
})

onBeforeUnmount(() => {
  map?.remove()
  map = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>
    <MapControls
      :basemaps="MB_BASEMAPS"
      :model-value="current"
      @update:model-value="setBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-tip">
      {{ readout || '拖动平移 · 滚轮缩放 · 右键拖拽旋转/俯仰' }}
    </div>
  </div>
</template>
