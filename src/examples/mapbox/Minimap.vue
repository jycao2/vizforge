<script setup lang="ts">
/**
 * 鹰眼小地图（Minimap / Overview）
 * ===========================================================================
 * 主图视野有限时，用一个小图告诉用户"我在哪"。实现要点：
 *
 *  - 小图 `interactive: false`：它只做显示，不接收鼠标事件，否则会和主图抢操作；
 *  - 同步：主图 `move` → 小图 `setCenter`（zoom 固定比主图小几级，视野更大）；
 *    反过来不同步，避免来回拉扯；
 *  - 视口框：把主图的 `getBounds()` 四个角组成多边形画在小图上，
 *    主图一动就 setData 更新；
 *  - 小图的 zoom 用 `主图 zoom - 4` 并夹到 [0, 20]，主图缩到很大时小图不会超出范围。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap, GeoJSONSource } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { fc, feat } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const mini = ref<HTMLDivElement>()
const readout = ref('')
let map: MbMap | null = null
let miniMap: MbMap | null = null

const HOME = { center: [120.15, 30.26] as [number, number], zoom: 12.5 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

function build() {
  if (!container.value || !mini.value) return
  map = createMap(container.value, { ...HOME })

  miniMap = createMap(mini.value, {
    center: HOME.center,
    zoom: Math.max(0, HOME.zoom - 4),
    interactive: false, // 关键：小图不吃鼠标事件
    attribution: false,
    navigation: false,
  })

  miniMap!.on('load', () => {
    if (!miniMap) return
    miniMap.addSource('box', { type: 'geojson', data: fc([]) })
    miniMap.addLayer({
      id: 'box-fill',
      type: 'fill',
      source: 'box',
      paint: { 'fill-color': '#4f9dff', 'fill-opacity': 0.15 },
    })
    miniMap.addLayer({
      id: 'box-line',
      type: 'line',
      source: 'box',
      paint: { 'line-color': '#4f9dff', 'line-width': 2 },
    })
    sync()
  })

  map!.on('move', sync)
  // 点击小图时把主图挪过去（小图本身不交互，所以事件挂在外层 div 上）
  mini.value.addEventListener('click', onMiniClick)
}

function onMiniClick(e: MouseEvent) {
  if (!miniMap || !mini.value || !map) return
  const r = mini.value.getBoundingClientRect()
  const p: [number, number] = [e.clientX - r.left, e.clientY - r.top]
  const lngLat = miniMap.unproject(p)
  map.flyTo({ center: [lngLat.lng, lngLat.lat], duration: 600 })
}

function sync() {
  if (!map || !miniMap) return
  miniMap.setCenter(map.getCenter())
  // 小图始终比主图少 4 级，保证视野更大
  miniMap.setZoom(Math.max(0, map.getZoom() - 4))
  const b = map.getBounds()
  const w = b.getWest()
  const e = b.getEast()
  const s = b.getSouth()
  const n = b.getNorth()
  const ring: Array<[number, number]> = [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
    [w, n],
  ]
  const src = miniMap.getSource('box') as GeoJSONSource | undefined
  src?.setData(feat({ type: 'Polygon', coordinates: [ring] }))
  const c = map.getCenter()
  readout.value = `主图 z${map.getZoom().toFixed(1)} · ${c.lng.toFixed(3)}, ${c.lat.toFixed(3)}`
}

onMounted(build)

onBeforeUnmount(() => {
  miniMap?.remove()
  map?.remove()
  map = null
  miniMap = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>
    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mini-wrap">
      <div ref="mini" class="mini"></div>
      <div class="mini-label">鹰眼</div>
    </div>
    <div class="mb-tip">{{ readout }} · 点击小图可跳转主图</div>
  </div>
</template>

<style scoped>
.mini-wrap {
  position: absolute;
  right: 14px;
  bottom: 34px;
  z-index: 25;
  width: 220px;
  height: 150px;
  border-radius: 10px;
  overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.22);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
  cursor: crosshair;
}
.mini {
  width: 100%;
  height: 100%;
}
.mini-label {
  position: absolute;
  left: 0;
  top: 0;
  padding: 2px 7px;
  background: rgba(12, 18, 26, 0.8);
  color: #cfe0f0;
  font-size: 10.5px;
  border-bottom-right-radius: 6px;
  pointer-events: none;
}
@media (max-width: 900px) {
  .mini-wrap {
    width: 150px;
    height: 100px;
  }
}
</style>
