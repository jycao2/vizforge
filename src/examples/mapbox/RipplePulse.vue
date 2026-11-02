<script setup lang="ts">
/**
 * 涟漪脉冲（热点告警的扩散波）
 * ===========================================================================
 * 大屏里表示「这里出事了」的通用语言：一圈圈从中心扩散、边扩散边变淡。
 *
 * 为什么不用 polygon + 半径动画？每帧重算 12 个 72 边形再 setData，数据量不大
 * 但要走 worker 解析，掉帧明显。这里改成「贴图 + 缩放」：
 *
 *   · 用 canvas 画一张带辉光的圆环，addCanvasImage 注册成 sprite；
 *   · 每个热点铺 4 个 symbol 图层，各自相位错开 1/4 周期；
 *   · 每帧只改 icon-size 与 icon-opacity —— 纯 GPU 缩放，12 层也很轻。
 *
 * 这是大屏特效的基本功：能用 sprite 缩放表达的效果，就别去动几何数据。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { MB_FONT } from './basemaps'
import { HOTSPOTS } from '@/examples/shared/screen'
import { addCanvasImage, createMap, radial, useMapboxView, useRaf, dimBasemap } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const HOME = { center: [120.224, 30.238] as [number, number], zoom: 12.55, pitch: 50, bearing: -12 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const RINGS = 4
const period = ref(2.6)
const paused = ref(false)
const ringIds: Array<{ layer: string; hotspot: number; phase: number }> = []

/**
 * 圆环贴图：画两圈（外圈细、内圈稍粗）+ shadowBlur 出辉光。
 * 颜色必须直接画进贴图 —— `icon-color` 只对 SDF 图标生效，普通 raster 图标染不了色。
 */
function drawRing(color: string) {
  return (ctx: CanvasRenderingContext2D, s: number) => {
    ctx.clearRect(0, 0, s, s)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.shadowColor = color
    ctx.shadowBlur = s * 0.09
    ctx.lineWidth = s * 0.035
    ctx.beginPath()
    ctx.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2)
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.strokeStyle = color
    ctx.lineWidth = s * 0.012
    ctx.beginPath()
    ctx.arc(s / 2, s / 2, s * 0.31, 0, Math.PI * 2)
    ctx.stroke()
  }
}

const LEVEL_COLOR: Record<string, string> = {
  high: '#ff7a6b',
  mid: '#ffd166',
  low: '#5fd8ff',
}

const LEVEL_HALO: Record<string, string> = {
  high: 'rgba(255,150,130,0.9)',
  mid: 'rgba(255,225,150,0.9)',
  low: 'rgba(150,230,255,0.9)',
}

function build() {
  if (!map) return
  // 每个等级一张贴图：三种颜色只差在 canvas 上那一笔，sprite 复用后缩放是零成本的
  for (const [lvl, color] of Object.entries(LEVEL_COLOR)) {
    addCanvasImage(map, `scr-ring-${lvl}`, 128, drawRing(color))
    addCanvasImage(map, `scr-halo-${lvl}`, 128, radial(128, LEVEL_HALO[lvl]))
  }

  map.addSource('hs', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: HOTSPOTS.map((h, i) => ({
        type: 'Feature' as const,
        properties: { id: i, name: h.name, value: h.value },
        geometry: { type: 'Point' as const, coordinates: h.center },
      })),
    },
  })

  // 每个热点：一圈地面光晕 + 4 层错相扩散环
  HOTSPOTS.forEach((h, i) => {
    const filter = ['==', ['get', 'id'], i]
    map!.addLayer({
      id: `halo-${i}`,
      type: 'symbol',
      source: 'hs',
      filter: filter as never,
      layout: { 'icon-image': `scr-halo-${h.level}`, 'icon-size': 0.5, 'icon-allow-overlap': true },
      paint: { 'icon-opacity': 0.4 },
    })
    for (let k = 0; k < RINGS; k++) {
      const id = `ring-${i}-${k}`
      map!.addLayer({
        id,
        type: 'symbol',
        source: 'hs',
        filter: filter as never,
        layout: {
          'icon-image': `scr-ring-${h.level}`,
          'icon-size': 0.3,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': 0.8 },
      })
      ringIds.push({ layer: id, hotspot: i, phase: k / RINGS })
    }
  })

  map.addLayer({
    id: 'hs-text',
    type: 'symbol',
    source: 'hs',
    layout: {
      'text-field': ['concat', ['get', 'name'], ' · ', ['to-string', ['get', 'value']]],
      'text-font': [MB_FONT],
      'text-size': 11.5,
      'text-offset': [0, 2.1],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#eef9ff', 'text-halo-color': 'rgba(3,10,20,0.9)', 'text-halo-width': 1.6 },
  })
}

let t = 0
useRaf((dt) => {
  if (!map || paused.value) return
  t += dt / period.value
  for (const r of ringIds) {
    // 0→1 的扩散进度：半径线性放大，透明度按 1.8 次幂衰减（衰减快一点才像波）
    const p = (t + r.phase) % 1
    const size = 0.12 + p * 1.15
    const opacity = Math.pow(1 - p, 1.8) * 0.85
    map.setLayoutProperty(r.layer, 'icon-size', size)
    map.setPaintProperty(r.layer, 'icon-opacity', opacity)
  }
})

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  map.once('load', () => {
  dimBasemap(map!)
  build()
})
})
onBeforeUnmount(() => {
  ringIds.length = 0
  map?.remove()
  map = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">实时告警热点</div>
        <div class="scr-sub">RIPPLE · ALERT PULSE</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">脉冲参数</div>
        <label class="scr-slider">
          <span>扩散周期</span>
          <input v-model.number="period" type="range" min="1" max="6" step="0.2" />
          <b>{{ period.toFixed(1) }}s</b>
        </label>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: !paused }" @click="paused = !paused">
            {{ paused ? '继续' : '暂停' }}
          </button>
        </div>
        <div class="scr-note">
          3 个热点 × {{ RINGS }} 层错相环，每帧只改 icon-size / icon-opacity
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">热点等级 <em>红 / 黄 / 青</em></div>
        <div class="scr-list">
          <div v-for="h in HOTSPOTS" :key="h.name" class="scr-item">
            <span>{{ h.name }}</span>
            <b :style="{ color: LEVEL_COLOR[h.level] }">{{ h.value }}</b>
            <div class="scr-bar" :class="{ warn: h.level === 'high' }">
              <i :style="{ width: `${h.value}%` }"></i>
            </div>
          </div>
        </div>
      </div>

      <div class="scr-tip">canvas 画一张辉光环 → addImage → 4 层 symbol 错相缩放，纯 GPU 特效，零数据更新</div>
    </div>

    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
  </div>
</template>

<style scoped>
.left {
  top: 76px;
  left: 16px;
  width: 210px;
}
.right {
  top: 76px;
  right: 16px;
  width: 200px;
}
.scr-note {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(140, 180, 210, 0.85);
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
