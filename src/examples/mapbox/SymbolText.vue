<script setup lang="ts">
/**
 * 图标与文字标注
 * ===========================================================================
 * symbol 图层是 Mapbox 样式体系里最"讲究"的一层，本例把它最常用的几个开关都摆出来：
 *
 *  - `icon-image` 不能直接填 URL，必须先用 `addImage` 注册（这里用 canvas 现画，
 *    所以图标颜色/形状可以参数化，也不依赖外部图片资源）；
 *  - `text-field` 依赖 glyphs：style 里必须配 SDF 字形服务，否则文字静默不显示；
 *    本项目用 fonts.openmaptiles.org（免 Token）；
 *  - `text-variable-anchor` + `text-radial-offset` 让标注在八个方向里自动挑不打架的位置；
 *  - `symbol-placement: 'line'` 让文字沿折线排布，并且会自动跳过过陡的弯角
 *    （`symbol-avoid-edges`、`text-max-angle`）；
 *  - 同一图层里 icon 与 text 共享一套碰撞盒，`text-optional` 可以在挤不下时只留图标。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { CITIES, fc, feat, track } from './data'
import { addCanvasImage, createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const avoid = ref(true)
const alongLine = ref(true)
let map: MbMap | null = null

const HOME = { center: [114.6, 31.4] as [number, number], zoom: 4.6 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 画一个带底座的圆形图标；size 是逻辑像素，pixelRatio 由 addCanvasImage 放大 */
function pinIcon(color: string) {
  return (ctx: CanvasRenderingContext2D, s: number) => {
    const r = s * 0.3
    ctx.beginPath()
    ctx.arc(s / 2, s / 2 - s * 0.06, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = s * 0.07
    ctx.strokeStyle = 'rgba(8,14,22,0.9)'
    ctx.stroke()
    // 下方小尖角，视觉上"钉"在点上
    ctx.beginPath()
    ctx.moveTo(s / 2 - s * 0.09, s / 2 + s * 0.2)
    ctx.lineTo(s / 2 + s * 0.09, s / 2 + s * 0.2)
    ctx.lineTo(s / 2, s / 2 + s * 0.42)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.stroke()
  }
}

function build() {
  if (!map) return
  addCanvasImage(map, 'pin-red', 40, pinIcon('#ff6b6b'))
  addCanvasImage(map, 'pin-blue', 40, pinIcon('#4f9dff'))
  addCanvasImage(map, 'pin-gold', 40, pinIcon('#ffd166'))

  map.addSource('poi', {
    type: 'geojson',
    data: fc(
      CITIES.map((c, i) =>
        feat({ type: 'Point', coordinates: c.c }, {
          name: c.name,
          v: c.v,
          kind: i % 3 === 0 ? 'hub' : i % 3 === 1 ? 'node' : 'leaf',
          icon: i % 3 === 0 ? 'pin-red' : i % 3 === 1 ? 'pin-blue' : 'pin-gold',
        }),
      ),
    ),
  })

  // 沿线的那条轨迹，用来演示 symbol-placement: line
  map.addSource('line', {
    type: 'geojson',
    data: feat({ type: 'LineString', coordinates: track(3, 90) }),
  })

  map.addLayer({
    id: 'line-path',
    type: 'line',
    source: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(79,157,255,0.5)', 'line-width': 3 },
  })

  map.addLayer({
    id: 'poi-symbol',
    type: 'symbol',
    source: 'poi',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': 0.9,
      'icon-allow-overlap': true,
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 15],
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-optional': true,
      'text-padding': 6,
    },
    paint: {
      'text-color': '#eaf2fb',
      'text-halo-color': 'rgba(6,12,22,0.92)',
      'text-halo-width': 1.6,
    },
  })

  map.addLayer({
    id: 'line-label',
    type: 'symbol',
    source: 'line',
    layout: {
      'symbol-placement': 'line',
      'text-field': '示例河流',
      'text-font': [MB_FONT],
      'text-size': 13,
      'text-letter-spacing': 0.25,
      'text-max-angle': 30,
      'symbol-spacing': 220,
    },
    paint: {
      'text-color': '#9bd7ff',
      'text-halo-color': 'rgba(6,12,22,0.9)',
      'text-halo-width': 1.4,
    },
  })

  applyOptions()
}

/** 碰撞避让开关：关掉之后密集处会互相压字 */
function applyOptions() {
  if (!map) return
  if (map.getLayer('poi-symbol')) {
    if (avoid.value) {
      map.setLayoutProperty('poi-symbol', 'text-variable-anchor', [
        'top',
        'bottom',
        'left',
        'right',
        'top-left',
        'top-right',
        'bottom-left',
        'bottom-right',
      ])
      map.setLayoutProperty('poi-symbol', 'text-radial-offset', 0.9)
      map.setLayoutProperty('poi-symbol', 'text-allow-overlap', false)
      map.setLayoutProperty('poi-symbol', 'icon-allow-overlap', false)
    } else {
      map.setLayoutProperty('poi-symbol', 'text-variable-anchor', ['top'])
      map.setLayoutProperty('poi-symbol', 'text-radial-offset', 0.9)
      map.setLayoutProperty('poi-symbol', 'text-allow-overlap', true)
      map.setLayoutProperty('poi-symbol', 'icon-allow-overlap', true)
    }
  }
  if (map.getLayer('line-label')) {
    map.setLayoutProperty('line-label', 'visibility', alongLine.value ? 'visible' : 'none')
  }
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
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
      <h4>标注选项</h4>
      <label class="mb-row">
        <input v-model="avoid" type="checkbox" @change="applyOptions" />
        <span>八字位碰撞避让</span>
      </label>
      <label class="mb-row">
        <input v-model="alongLine" type="checkbox" @change="applyOptions" />
        <span>沿线文字（line）</span>
      </label>
      <div class="hint">图标用 addImage 注册，文字走 SDF 字形服务</div>
    </div>
    <div class="mb-tip">缩放看看标注如何自动让位 · 关闭避让会立刻压字</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 200px;
}
.hint {
  margin-top: 6px;
  color: #8fa4b9;
  font-size: 11px;
  line-height: 1.5;
}
</style>
