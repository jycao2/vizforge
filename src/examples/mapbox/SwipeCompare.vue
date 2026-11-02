<script setup lang="ts">
/**
 * 卷帘对比（Swipe）
 * ===========================================================================
 * 对比"改造前 / 改造后""影像 / 矢量"最直观的方式。
 * Mapbox 的图层没有 clip 参数，官方做法是**叠两个 Map 实例**：
 *
 *  - 下层：完整显示（本例深色矢量风）；
 *  - 上层：绝对定位覆盖，用 `clip-path: inset(0 X% 0 0)` 裁掉右半边，只露左半；
 *  - 两个 map 的视图必须严格同步：监听 `move`，把 center/zoom/bearing/pitch
 *    抄给对方。这里用一个 `syncing` 标志防止互相触发造成死循环；
 *  - 上层地图的交互要关掉（interactive: false），否则鼠标事件会被它吃掉，
 *    下层就拖不动了。
 *
 * 拖动条本身是一个绝对定位的 div，用 pointerdown/move/up 手动处理（不引第三方库）。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { rasterStyle } from './basemaps'
import { CITIES, fc, feat } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const bottom = ref<HTMLDivElement>()
const topRef = ref<HTMLDivElement>()
const pos = ref(50)
let mapA: MbMap | null = null // 下层
let mapB: MbMap | null = null // 上层
let syncing = false

const HOME = { center: [120.15, 30.26] as [number, number], zoom: 12 }
// 工具栏只绑下层（上层关了交互）
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => mapA, HOME)

/** 双向同步：任一地图移动 → 把视图抄给另一个 */
function link(a: MbMap, b: MbMap) {
  a.on('move', () => {
    if (syncing) return
    syncing = true
    b.jumpTo({
      center: a.getCenter(),
      zoom: a.getZoom(),
      bearing: a.getBearing(),
      pitch: a.getPitch(),
    })
    syncing = false
  })
}

function addMarkers(m: MbMap, color: string) {
  m.addSource('poi', {
    type: 'geojson',
    data: fc(
      CITIES.slice(0, 8).map((c) => feat({ type: 'Point', coordinates: c.c }, { name: c.name })),
    ),
  })
  m.addLayer({
    id: 'poi',
    type: 'circle',
    source: 'poi',
    paint: { 'circle-radius': 5, 'circle-color': color, 'circle-opacity': 0.9 },
  })
}

function build() {
  if (!bottom.value || !topRef.value) return
  mapA = createMap(bottom.value, { ...HOME, style: rasterStyle('dark') })
  // 上层用影像，且关掉交互
  mapB = createMap(topRef.value, {
    ...HOME,
    style: rasterStyle('imagery'),
    interactive: false,
    attribution: false,
    navigation: false,
  })
  mapA!.on('load', () => addMarkers(mapA!, '#ffd166'))
  mapB!.on('load', () => addMarkers(mapB!, '#4f9dff'))
  link(mapA!, mapB!)
  link(mapB!, mapA!)
}

/* ---- 拖动条 ---- */
function onPointerDown(ev: PointerEvent) {
  const el = ev.currentTarget as HTMLElement
  el.setPointerCapture(ev.pointerId)
  const move = (e: PointerEvent) => {
    const r = wrapRef.value?.getBoundingClientRect()
    if (!r) return
    pos.value = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}

onMounted(build)

onBeforeUnmount(() => {
  mapB?.remove()
  mapA?.remove()
  mapA = null
  mapB = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="bottom" class="mb-container layer"></div>
    <div
      ref="topRef"
      class="mb-container layer top"
      :style="{ clipPath: `inset(0 ${100 - pos}% 0 0)` }"
    ></div>
    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-panel ctrl">
      <h4>卷帘对比</h4>
      <div class="mb-row">
        <span>左</span>
        <input v-model.number="pos" type="range" min="0" max="100" step="0.5" />
        <span>右</span>
      </div>
      <div class="hint">左：影像底图 · 右：深色底图</div>
    </div>
    <div class="swipe" :style="{ left: `${pos}%` }" @pointerdown="onPointerDown">
      <span class="knob">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M9.5 6 4.5 12l5 6M14.5 6l5 6-5 6" /></svg>
      </span>
    </div>
    <div class="mb-tip">拖动中缝 · 两个 Map 实例视图互相同步（syncing 标志防死循环）</div>
  </div>
</template>

<style scoped>
.layer {
  position: absolute;
  inset: 0;
}
.top {
  z-index: 2;
  pointer-events: none;
}
.ctrl {
  top: 14px;
  left: 14px;
  width: 216px;
  z-index: 25;
}
.mb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
}
.mb-row input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4f9dff;
}
.hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
}
/* 中缝：一条竖线 + 中间把手 */
.swipe {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: rgba(255, 255, 255, 0.85);
  z-index: 24;
  cursor: ew-resize;
  touch-action: none;
}
.knob {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(20, 27, 38, 0.92);
  border: 2px solid rgba(255, 255, 255, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
}
.knob svg {
  fill: none;
  stroke: #eaf2fb;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
