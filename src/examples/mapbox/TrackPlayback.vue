<script setup lang="ts">
/**
 * 轨迹回放
 * ===========================================================================
 * 车辆/人员轨迹回放是定位类项目的高频需求，本例给出最小可用实现：
 *
 *  - 轨迹是一整条 LineString，回放时按"已走过的比例"切成两条线：
 *    已走过（亮色实线）+ 未走过（暗色虚线），用 setData 更新即可；
 *  - 当前位置用一个 DOM Marker，朝向取相邻两点的方位角（setRotation），
 *    这样车头会跟着路拐弯；
 *  - 进度用 requestAnimationFrame 推进（useRaf），而不是 setInterval —— 后者
 *    在标签页切走后会被节流成 1s 一次，回放会一卡一卡；
 *  - 倍速与进度条都只改一个 ref，动画循环读它，不需要重建任何监听。
 *
 * 沿线插值用 alongLine（见 useMapbox.ts）：按段长累加找到目标弧长位置，
 * 直接按点索引插值会导致"点密的地方走得慢"。
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { alongLine, createMap, useMapboxView, useRaf } from './useMapbox'
import { track } from './data'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const progress = ref(0)
const playing = ref(true)
const speed = ref(1)
const info = ref('')
let map: MbMap | null = null
let marker: maplibregl.Marker | null = null

const PATH = track(11, 140)
const HOME = { center: PATH[0] as [number, number], zoom: 14 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 方位角（deg，0 = 北），用来转车头图标 */
function bearing(a: [number, number], b: [number, number]): number {
  const dy = b[1] - a[1]
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180)
  return (Math.atan2(dx, dy) * 180) / Math.PI
}

function setTrackSources() {
  if (!map) return
  const i = Math.max(0, Math.min(PATH.length - 2, Math.floor(progress.value * (PATH.length - 1))))
  // 按弧长插值，点密的地方不会"走得慢"
  const here = alongLine(PATH, progress.value)
  const done = PATH.slice(0, i + 1).concat([here])

  const srcDone = map.getSource('done') as maplibregl.GeoJSONSource | undefined
  const srcAll = map.getSource('all') as maplibregl.GeoJSONSource | undefined
  srcDone?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: done } })
  srcAll?.setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: PATH },
  })

  if (marker) {
    marker.setLngLat(here)
    const b = bearing(PATH[i], PATH[Math.min(PATH.length - 1, i + 2)])
    marker.setRotation(b)
    if (playing.value) map.easeTo({ center: here, duration: 260, easing: (t) => t })
  }
  info.value = `第 ${i + 1}/${PATH.length} 点 · 方位 ${bearing(PATH[i], PATH[Math.min(PATH.length - 1, i + 2)]).toFixed(0)}°`
}

function build() {
  if (!map) return
  map.addSource('all', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: PATH } },
  })
  map.addSource('done', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [PATH[0]] } },
  })

  // 未走过的部分：暗色虚线
  map.addLayer({
    id: 'path-all',
    type: 'line',
    source: 'all',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': 'rgba(140,165,190,0.5)',
      'line-width': 3,
      'line-dasharray': [2, 2],
    },
  })
  // 已走过的部分：亮色实线
  map.addLayer({
    id: 'path-done',
    type: 'line',
    source: 'done',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#4f9dff', 'line-width': 4.5, 'line-blur': 0.4 },
  })

  const el = document.createElement('div')
  el.className = 'car'
  el.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2.5 20.5 21 12 17.6 3.5 21z" fill="#ffd166" stroke="#0a121c" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(PATH[0]).addTo(map)

  setTrackSources()
}

useRaf((dt) => {
  if (!playing.value) return
  progress.value += dt * 0.06 * speed.value
  if (progress.value >= 1) progress.value = 0 // 循环播放
  setTrackSources()
})

function onScrub(ev: Event) {
  progress.value = Number((ev.target as HTMLInputElement).value) / 1000
  setTrackSources()
}

function restart() {
  progress.value = 0
  playing.value = true
  setTrackSources()
}

watch(playing, () => setTrackSources())

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
})

onBeforeUnmount(() => {
  marker?.remove()
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
      <h4>轨迹回放</h4>
      <div class="bar">
        <input
          type="range"
          min="0"
          max="1000"
          :value="Math.round(progress * 1000)"
          @input="onScrub"
        />
      </div>
      <div class="btns">
        <button class="mb-btn" @click="playing = !playing">
          {{ playing ? '暂停' : '继续' }}
        </button>
        <button class="mb-btn" @click="restart">重播</button>
        <button
          class="mb-btn"
          :class="{ on: speed === 4 }"
          @click="speed = speed === 4 ? 1 : 4"
        >
          {{ speed }}×
        </button>
      </div>
      <div class="hint">{{ info }}</div>
    </div>
    <div class="mb-tip">140 个轨迹点 · 拖动进度条可手动定位，图标朝向随路转向</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 226px;
}
.bar {
  margin-bottom: 8px;
}
.bar input {
  width: 100%;
  accent-color: #4f9dff;
}
.btns {
  display: flex;
  gap: 6px;
}
.hint {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
</style>

<style>
.car {
  display: flex;
  align-items: center;
  justify-content: center;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5));
}
</style>
