<script setup lang="ts">
/**
 * 标记与弹窗
 * ===========================================================================
 * Mapbox 里放标记有两条路，各有各的适用场景，本例同时展示：
 *
 *  1) `new Marker(...)` —— DOM 元素浮在地图上方，可以放任意 HTML / CSS 动画，
 *     适合数量少、需要复杂交互（按钮、图表、旋转动画）的点位。
 *  2) symbol 图层 —— 走 style 的 GPU 渲染，几万个点也不卡，
 *     但没有 DOM，交互只能靠 queryRenderedFeatures 或图层事件。
 *
 * 弹窗用 `new Popup()`：DOM 型，支持 closeButton、offset、HTML 内容。
 * 注意 Popup 的 setLngLat + addTo 之后就自己管生命周期了，组件卸载要 remove()，
 * 否则 DOM 会残留在 body 上（Mapbox 的 Popup 挂在 map container 里，map.remove 会带走，
 * 但手动 remove 更稳妥，也避免切换示例时的闪烁）。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { CITIES } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const useDomMarker = ref(true)
let map: MbMap | null = null
let popup: maplibregl.Popup | null = null
const domMarkers: maplibregl.Marker[] = []

const HOME = { center: [113.9, 32.5] as [number, number], zoom: 4 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 弹窗内容：用统一类名排版，样式见 mb-ui.css */
function popupHtml(c: (typeof CITIES)[number]) {
  return (
    `<div class="mb-pop-title">${c.name}</div>` +
    `<div class="mb-pop-row"><span>经度</span><b>${c.c[0].toFixed(3)}°</b></div>` +
    `<div class="mb-pop-row"><span>纬度</span><b>${c.c[1].toFixed(3)}°</b></div>` +
    `<div class="mb-pop-row"><span>指标</span><b>${c.v}</b></div>`
  )
}

function showPopup(c: (typeof CITIES)[number]) {
  if (!map) return
  popup?.remove()
  popup = new maplibregl.Popup({ offset: 14, closeButton: true, maxWidth: '260px' })
    .setLngLat(c.c)
    .setHTML(popupHtml(c))
    .addTo(map)
}

/** DOM 标记：自带脉冲动画的 HTML 元素 */
function buildDomMarkers() {
  if (!map) return
  clearDomMarkers()
  CITIES.forEach((c) => {
    const el = document.createElement('div')
    el.className = 'city-marker'
    el.innerHTML = `<span class="cm-dot"></span><span class="cm-name">${c.name}</span>`
    el.addEventListener('click', (ev) => {
      ev.stopPropagation()
      showPopup(c)
    })
    domMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(c.c).addTo(map!))
  })
}

function clearDomMarkers() {
  domMarkers.forEach((m) => m.remove())
  domMarkers.length = 0
}

/** symbol 标记：一个 GeoJSON source + circle/symbol 两个图层 */
function buildSymbolMarkers() {
  if (!map) return
  map.addSource('cities', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: CITIES.map((c) => ({
        type: 'Feature' as const,
        properties: { name: c.name, v: c.v },
        geometry: { type: 'Point' as const, coordinates: c.c },
      })),
    },
  })
  map.addLayer({
    id: 'cities-halo',
    type: 'circle',
    source: 'cities',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'v'], 20, 7, 100, 16],
      'circle-color': 'rgba(79,157,255,0.22)',
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(79,157,255,0.55)',
    },
  })
  map.addLayer({
    id: 'cities-dot',
    type: 'circle',
    source: 'cities',
    paint: {
      'circle-radius': 3.4,
      'circle-color': '#ffd166',
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(0,0,0,0.45)',
    },
  })
  map.addLayer({
    id: 'cities-label',
    type: 'symbol',
    source: 'cities',
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 12,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#eaf2fb',
      'text-halo-color': 'rgba(6,12,22,0.9)',
      'text-halo-width': 1.4,
    },
  })
  // 图层型标记没有 DOM 事件，只能从图层事件拿要素
  map.on('click', 'cities-dot', (e) => {
    const f = e.features?.[0]
    if (!f) return
    const name = f.properties?.name as string
    const city = CITIES.find((c) => c.name === name)
    if (city) showPopup(city)
  })
  map.on('mouseenter', 'cities-dot', () => {
    if (map) map.getCanvas().style.cursor = 'pointer'
  })
  map.on('mouseleave', 'cities-dot', () => {
    if (map) map.getCanvas().style.cursor = ''
  })
}

function clearSymbolMarkers() {
  if (!map) return
  ;['cities-label', 'cities-dot', 'cities-halo'].forEach((id) => {
    if (map!.getLayer(id)) map!.removeLayer(id)
  })
  if (map.getSource('cities')) map.removeSource('cities')
}

function switchMode() {
  useDomMarker.value = !useDomMarker.value
  popup?.remove()
  if (useDomMarker.value) {
    clearSymbolMarkers()
    buildDomMarkers()
  } else {
    clearDomMarkers()
    buildSymbolMarkers()
  }
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  buildDomMarkers()
  // 点空白处关掉弹窗
  map!.on('click', () => popup?.remove())
})

onBeforeUnmount(() => {
  clearDomMarkers()
  popup?.remove()
  map?.remove()
  map = null
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
    <div class="mb-panel ctrl">
      <h4>标记方式</h4>
      <button class="mb-btn" :class="{ on: useDomMarker }" @click="switchMode">
        {{ useDomMarker ? 'DOM Marker（HTML）' : 'Symbol 图层（GPU）' }}
      </button>
      <div class="hint">
        {{ useDomMarker ? '22 个 HTML 标记，可挂任意 DOM 与动画' : '一个 source 三个图层，上万点也不掉帧' }}
      </div>
    </div>
    <div class="mb-tip">点击标记弹出信息窗 · 点空白处关闭</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 210px;
}
.hint {
  margin-top: 6px;
  color: #8fa4b9;
  font-size: 11px;
  line-height: 1.5;
}
</style>

<style>
/* DOM 标记是挂到 map container 上的，scoped 选择器命中不了，用全局样式 */
.city-marker {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.cm-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffd166;
  border: 2px solid rgba(10, 16, 24, 0.85);
  box-shadow: 0 0 0 0 rgba(255, 209, 102, 0.55);
  animation: mb-pulse 1.8s ease-out infinite;
}
.cm-name {
  margin-top: 3px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(12, 18, 26, 0.82);
  color: #eaf2fb;
  font-size: 11px;
  white-space: nowrap;
}
@keyframes mb-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 209, 102, 0.5);
  }
  70% {
    box-shadow: 0 0 0 14px rgba(255, 209, 102, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 209, 102, 0);
  }
}
</style>
