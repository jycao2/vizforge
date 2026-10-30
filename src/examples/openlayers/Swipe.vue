<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import { fromLonLat } from 'ol/proj'
import type RenderEvent from 'ol/render/Event'
import type TileSource from 'ol/source/Tile'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS, createOlSource } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const split = ref(50)
const dragging = ref(false)

let map: Map | null = null

const CENTER = fromLonLat([116.391, 39.907])

const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, 9)
const { current: currentBasemap, create, apply } = useOlBasemap('imagery')

function setSplit(v: number) {
  split.value = Math.min(96, Math.max(4, v))
  map?.render()
}

function onHandleDown(ev: PointerEvent) {
  dragging.value = true
  ;(ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId)
  ev.preventDefault()
}
function onMove(ev: PointerEvent) {
  if (!dragging.value || !wrapRef.value) return
  const rect = wrapRef.value.getBoundingClientRect()
  setSplit(((ev.clientX - rect.left) / rect.width) * 100)
}
function onUp() {
  dragging.value = false
}

onMounted(() => {
  const base = create()

  // 上层：矢量图，按 split 裁剪出右半部分
  // ol 的类型声明里图层只暴露了 prerender/postrender，实际运行支持 precompose/postcompose，这里补一个窄类型
  type ComposableLayer = TileLayer<TileSource> & {
    on(type: 'precompose' | 'postcompose', listener: (e: RenderEvent) => void): void
  }
  const right = new TileLayer({ source: createOlSource('street') }) as ComposableLayer

  right.on('precompose', (e: RenderEvent) => {
    const ctx2d = e.context as CanvasRenderingContext2D | null
    if (!ctx2d) return
    const size = e.frameState?.size ?? [1, 1]
    const w = (size[0] * split.value) / 100
    ctx2d.save()
    ctx2d.beginPath()
    ctx2d.rect(w, 0, size[0] - w, size[1])
    ctx2d.clip()
  })
  right.on('postcompose', (e: RenderEvent) => {
    const ctx2d = e.context as CanvasRenderingContext2D | null
    ctx2d?.restore()
  })

  map = new Map({
    target: container.value!,
    layers: [base, right],
    view: new View({ center: CENTER, zoom: 9 }),
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
})
</script>

<template>
  <div
    ref="wrapRef"
    class="map-wrap"
    :class="{ dragging }"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
  >
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

    <div class="split-handle" :style="{ left: split + '%' }" @pointerdown="onHandleDown">
      <span class="grip"></span>
    </div>
    <div class="tag left">左：影像</div>
    <div class="tag right">右：矢量</div>

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
      <div class="hint">通过图层 precompose / postcompose 钩子调用 canvas clip，只绘制右侧区域。</div>
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
.ol-container {
  width: 100%;
  height: 100%;
}
.split-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.8);
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.5);
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
  background: #fff;
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
  line-height: 1.5;
  color: #8b9aab;
}
</style>
