<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS, createCesiumImagery } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const split = ref(50)
const dragging = ref(false)

let viewer: Cesium.Viewer | null = null

const home = {
  destination: Cesium.Cartesian3.fromDegrees(116.391, 39.907, 60000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-60),
    roll: 0,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
// 卷帘场景自己管理影像图层，这里只复用底图按钮的选中状态
const { current: currentBasemap } = useCesiumBasemap(() => viewer)

function setSplit(percent: number) {
  split.value = Math.min(96, Math.max(4, percent))
  if (viewer) viewer.scene.splitPosition = split.value / 100
}

function onHandleDown(ev: PointerEvent) {
  dragging.value = true
  ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
  ev.preventDefault()
}
function onPointerMove(ev: PointerEvent) {
  if (!dragging.value || !wrapRef.value) return
  const rect = wrapRef.value.getBoundingClientRect()
  setSplit(((ev.clientX - rect.left) / rect.width) * 100)
}
function onPointerUp() {
  dragging.value = false
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })

  // 左半屏：影像；右半屏：矢量图
  const left = viewer.imageryLayers.addImageryProvider(createCesiumImagery('imagery'))
  const right = viewer.imageryLayers.addImageryProvider(createCesiumImagery('street'))
  left.splitDirection = Cesium.SplitDirection.LEFT
  right.splitDirection = Cesium.SplitDirection.RIGHT
  currentBasemap.value = 'imagery'

  viewer.scene.splitPosition = split.value / 100
  viewer.camera.setView(home)
})

onBeforeUnmount(() => {
  viewer?.destroy()
  viewer = null
})

// 自定义底图按钮：只替换「左侧」底图，右侧固定为矢量图以便对比
function applyLeft(id: string) {
  if (!viewer) return
  const layers = viewer.imageryLayers
  const old = layers.get(0)
  if (old) layers.remove(old, true)
  const layer = layers.addImageryProvider(createCesiumImagery(id))
  layer.splitDirection = Cesium.SplitDirection.LEFT
  layers.lowerToBottom(layer)
  currentBasemap.value = id
}
</script>

<template>
  <div
    ref="wrapRef"
    class="map-wrap"
    :class="{ dragging }"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div ref="container" class="cesium-container"></div>

    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyLeft"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="split-handle" :style="{ left: split + '%' }" @pointerdown="onHandleDown">
      <span class="grip"></span>
    </div>

    <div class="tag left">左侧：{{ currentBasemap === 'imagery' ? '影像' : '底图' }}</div>
    <div class="tag right">右侧：矢量</div>

    <div class="panel">
      <div class="row">
        <span class="label">卷帘位置</span>
        <input
          class="range"
          type="range"
          min="4"
          max="96"
          :value="split"
          @input="setSplit(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ Math.round(split) }}%</span>
      </div>
      <div class="hint">拖动中间手柄或滑块，对比左右两种底图；相机为同一个，视图始终同步。</div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.map-wrap.dragging {
  cursor: ew-resize;
}
.cesium-container {
  width: 100%;
  height: 100%;
}
.split-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.75);
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.55);
  z-index: 25;
  cursor: ew-resize;
  transform: translateX(-1px);
}
.grip {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 26px;
  height: 26px;
  margin: -13px 0 0 -13px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}
.grip::before {
  content: '';
  position: absolute;
  inset: 8px 6px;
  border-left: 2px solid #4f9dff;
  border-right: 2px solid #4f9dff;
}
.tag {
  position: absolute;
  top: 14px;
  z-index: 20;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(17, 24, 34, 0.8);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 12px;
  pointer-events: none;
}
.tag.left {
  left: 14px;
}
.tag.right {
  right: 60px;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 320px;
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
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
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
.hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.55;
  color: #8b9aab;
}
</style>
