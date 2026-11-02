<script setup lang="ts">
/**
 * 三维建筑（fill-extrusion）
 * ===========================================================================
 * Mapbox 的三维不用引第三方库：把面要素交给 `fill-extrusion` 图层，
 * 它按 `fill-extrusion-height` 把多边形沿法线拉成体块，和地形、天空共用一套渲染管线。
 *
 * 几个容易踩的点：
 *  - 只有 pitch > 0 才看得出立体感，初始化时就把 pitch 给到 55~70；
 *  - `fill-extrusion-base` 可以抬空（做悬空楼板/挑高），默认 0 贴地；
 *  - 高度字段是"米"，不是像素，也不是相对屏幕比例 —— 用真实楼高（本例 12~240m）；
 *  - 垂直面默认很暗，靠 `fill-extrusion-vertical-gradient`（v3）让侧面有一点渐变，
 *    否则整片楼看起来是纯色块；
 *  - 体块会互相遮挡，加 `fill-extrusion-opacity` 略小于 1 能看到内部结构。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { blocks, mulberry32 } from './data'
import { createMap, useMapboxView, useRaf } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const heightScale = ref(1)
const spinning = ref(false)
let map: MbMap | null = null

const CENTER: [number, number] = [120.16, 30.26]
const HOME = { center: CENTER, zoom: 14.6, pitch: 62, bearing: -22 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

function build() {
  if (!map) return

  // CBD：中心高、边缘低，再随机点缀几栋塔楼
  const rnd = mulberry32(5)
  const data = blocks([CENTER[0] - 0.032, CENTER[1] - 0.022], 22, 22, 0.0029, 5)
  data.features.forEach((f) => {
    const p = f.properties as Record<string, number>
    if (rnd() < 0.05) p.height = Math.round(p.height * (1.6 + rnd()))
    p.base = 0
  })

  map.addSource('buildings', { type: 'geojson', data })
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'buildings',
    paint: {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['get', 'height'],
        12,
        '#22496e',
        80,
        '#3f7fb5',
        160,
        '#6fb3e0',
        240,
        '#a9dcf5',
      ],
      'fill-extrusion-height': ['*', ['get', 'height'], heightScale.value],
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-opacity': 0.92,
      'fill-extrusion-vertical-gradient': true,
    },
  })

  // 楼顶标高文字：只在放大后显示，避免小层级糊成一团
  map.addLayer({
    id: 'buildings-label',
    type: 'symbol',
    source: 'buildings',
    minzoom: 15,
    layout: {
      'text-field': ['concat', ['to-string', ['get', 'height']], 'm'],
      'text-font': [MB_FONT],
      'text-size': 10.5,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#dbe9f7',
      'text-halo-color': 'rgba(6,12,22,0.85)',
      'text-halo-width': 1.2,
    },
  })

  // 天空：v3 才有 setSky；老版本没有就跳过（不影响建筑本身）
  try {
    // setSky 是 v3 才有的 API，类型定义里未必覆盖，这里做一次运行时探测
    const withSky = map as unknown as { setSky?: (o: unknown) => void }
    withSky.setSky?.({
      'sky-color': '#0b1524',
      'sky-horizon-blend': 0.6,
      'horizon-color': '#1d3b5c',
      'horizon-fog-blend': 0.5,
      'fog-color': '#101a28',
      'fog-ground-blend': 0.7,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 14, 0.8, 18, 0.35],
    } as never)
  } catch {
    /* 低版本无 setSky，忽略 */
  }
}

function setScale(v: number) {
  heightScale.value = v
  if (!map || !map.getLayer('buildings-3d')) return
  map.setPaintProperty('buildings-3d', 'fill-extrusion-height', [
    '*',
    ['get', 'height'],
    v,
  ])
}

// 自转：每帧微调 bearing，比 setInterval 平滑（跟随刷新率）
const spin = ref(false)
useRaf((dt) => {
  if (!spin.value || !map) return
  map.setBearing(map.getBearing() + dt * 6)
})

function toggleSpin() {
  spinning.value = !spinning.value
  spin.value = spinning.value
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME, pitch: HOME.pitch })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
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
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-panel ctrl">
      <h4>三维建筑</h4>
      <label class="mb-row">
        <span>楼高</span>
        <input
          type="range"
          min="0.3"
          max="2.5"
          step="0.1"
          :value="heightScale"
          @input="setScale(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ heightScale.toFixed(1) }}×</b>
      </label>
      <button class="mb-btn" :class="{ on: spinning }" @click="toggleSpin">
        {{ spinning ? '停止自转' : '自动旋转' }}
      </button>
      <div class="hint">右键拖拽可手动调整倾角与方位</div>
    </div>
    <div class="mb-tip">484 栋建筑体块 · 高度 12–240m，颜色按楼高插值</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 220px;
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
.mb-row b {
  width: 34px;
  text-align: right;
  color: #eaf2fb;
  font-variant-numeric: tabular-nums;
}
.hint {
  margin-top: 6px;
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
