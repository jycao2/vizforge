<script setup lang="ts">
/**
 * 发光光墙（大屏同款「围栏」）
 * ===========================================================================
 * 大屏里最常见的边界表达：从地面升起一圈半透明的发光墙，把「关注区域」框起来。
 *
 * 但 fill-extrusion 只能拉伸封闭多边形，画不出「一条竖起来的线」。做法是把
 * 边界每一段边加厚成一条窄条带（ringToWall），再整体拉伸 —— 视觉上就是一堵
 * 沿边界走的墙。难点只有一个：单层墙体又薄又暗，所以叠两层：
 *
 *   · 内层：不透明一点、矮一点，是「墙」本身；
 *   · 外层：几乎全透明、高 12%，向外发光的那圈才是「辉光」。
 *
 * 呼吸效果靠每帧改 fill-extrusion-height：高度表达式写成
 * `['*', ['get','base'], factor]`，只换 factor 一个数，不需要重传数据。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { GeoJSONSource, Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { MB_FONT } from './basemaps'
import { ZONES, nGon, ringToWall } from '@/examples/shared/screen'
import { createMap, useMapboxView, useRaf, dimBasemap } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const HOME = { center: [120.215, 30.2335] as [number, number], zoom: 12.85, pitch: 62, bearing: -22 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const wallH = ref(150)
const breathe = ref(true)
const alpha = ref(0.5)
const active = ref<string | null>(null)

/** 墙的半宽：9 米 ≈ 视觉上一条有厚度的堤，太薄会闪烁 */
const HALF_W = 9

interface WallFeature {
  type: 'Feature'
  properties: { id: string; name: string; value: number; base: number }
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] }
}

function wallData(): { type: 'FeatureCollection'; features: WallFeature[] } {
  return {
    type: 'FeatureCollection',
    features: ZONES.map((z) => {
      const ring = nGon(z.center, z.radiusKm, 40, z.value)
      // 每个片区高度按指标给，光墙一眼就能看出「哪块更紧张」
      const base = wallH.value * (0.55 + (z.value / 100) * 0.55)
      return {
        type: 'Feature',
        properties: { id: z.id, name: z.name, value: z.value, base },
        geometry: {
          type: 'MultiPolygon',
          coordinates: ringToWall(ring, HALF_W).map((quad) => [quad]),
        },
      }
    }),
  }
}

function build() {
  if (!map) return
  map.addSource('wall', { type: 'geojson', data: wallData() })

  // 外层辉光：高 12%、几乎全透明
  map.addLayer({
    id: 'wall-glow',
    type: 'fill-extrusion',
    source: 'wall',
    paint: {
      'fill-extrusion-height': ['*', ['get', 'base'], 1.12],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.1,
      'fill-extrusion-color': '#7fe8ff',
      'fill-extrusion-vertical-gradient': false,
    },
  })

  // 内层墙体：vertical-gradient 打开，底部浓顶部淡，像一层雾幕
  map.addLayer({
    id: 'wall-core',
    type: 'fill-extrusion',
    source: 'wall',
    paint: {
      'fill-extrusion-height': ['get', 'base'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': alpha.value,
      'fill-extrusion-color': '#2ea8ff',
      'fill-extrusion-vertical-gradient': true,
    },
  })

  // 墙脚一圈亮线：给墙体「落地」的锚点，否则悬在暗底图上像浮着
  map.addSource('wall-foot', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: ZONES.map((z) => ({
        type: 'Feature' as const,
        properties: { id: z.id, name: z.name, value: z.value },
        geometry: { type: 'LineString' as const, coordinates: nGon(z.center, z.radiusKm, 40, z.value) },
      })),
    },
  })
  map.addLayer({
    id: 'foot-glow',
    type: 'line',
    source: 'wall-foot',
    paint: { 'line-color': '#6fe4ff', 'line-width': 9, 'line-blur': 8, 'line-opacity': 0.6 },
  })
  map.addLayer({
    id: 'foot-line',
    type: 'line',
    source: 'wall-foot',
    paint: { 'line-color': '#d8f7ff', 'line-width': 1.6, 'line-opacity': 0.95 },
  })

  map.addSource('wall-label', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: ZONES.map((z) => ({
        type: 'Feature' as const,
        properties: { name: z.name, value: z.value },
        geometry: { type: 'Point' as const, coordinates: z.center },
      })),
    },
  })
  map.addLayer({
    id: 'wall-label',
    type: 'symbol',
    source: 'wall-label',
    layout: {
      'text-field': ['concat', ['get', 'name'], ' · ', ['to-string', ['get', 'value']]],
      'text-font': [MB_FONT],
      'text-size': 11,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#eaf8ff', 'text-halo-color': 'rgba(3,10,20,0.9)', 'text-halo-width': 1.4 },
  })

  // 点墙体选中片区：其余压暗，突出当前关注区域
  map.on('click', 'wall-core', (e) => {
    const id = e.features?.[0]?.properties?.id as string | undefined
    if (id) pick(id === active.value ? null : id)
  })
  map.on('mouseenter', 'wall-core', () => {
    if (map) map.getCanvas().style.cursor = 'pointer'
  })
  map.on('mouseleave', 'wall-core', () => {
    if (map) map.getCanvas().style.cursor = ''
  })
}

function pick(id: string | null) {
  active.value = id
  if (!map) return
  // setFilter 走 worker 侧索引过滤，比 setData 便宜得多
  const f = id ? ['==', ['get', 'id'], id] : null
  map.setFilter('wall-core', f as never)
  map.setFilter('wall-glow', f as never)
  map.setFilter('foot-line', f as never)
  map.setFilter('wall-label', id ? ['==', ['get', 'name'], ZONES.find((z) => z.id === id)!.name] : null)
}

let phase = 0
useRaf((dt) => {
  if (!map || !map.getLayer('wall-core')) return
  if (!breathe.value) return
  phase += dt * 1.5
  // 0.86~1.14 来回摆：幅度再大就像在跳动
  const f = 1 + Math.sin(phase) * 0.14
  map.setPaintProperty('wall-core', 'fill-extrusion-height', ['*', ['get', 'base'], f] as never)
  map.setPaintProperty('wall-glow', 'fill-extrusion-height', ['*', ['get', 'base'], f * 1.12] as never)
})

function applyHeight() {
  // 注意是 getSource 不是 getLayer：wall 是数据源 id
  const src = map?.getSource('wall') as GeoJSONSource | undefined
  src?.setData(wallData() as never)
}
function applyAlpha() {
  if (map?.getLayer('wall-core')) map.setPaintProperty('wall-core', 'fill-extrusion-opacity', alpha.value)
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  map.once('load', () => {
  dimBasemap(map!)
  build()
})
})
onBeforeUnmount(() => {
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
        <div class="scr-title">重点片区管控</div>
        <div class="scr-sub">GLOW WALL · BOUNDARY FENCE</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">光墙参数</div>
        <label class="scr-slider">
          <span>基准高度</span>
          <input
            v-model.number="wallH"
            type="range"
            min="40"
            max="320"
            step="10"
            @input="applyHeight"
          />
          <b>{{ wallH }}m</b>
        </label>
        <label class="scr-slider">
          <span>墙体浓度</span>
          <input
            v-model.number="alpha"
            type="range"
            min="0.15"
            max="0.85"
            step="0.05"
            @input="applyAlpha"
          />
          <b>{{ alpha.toFixed(2) }}</b>
        </label>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: breathe }" @click="breathe = !breathe">呼吸脉动</button>
          <button class="scr-btn" :class="{ on: !active }" @click="pick(null)">全部片区</button>
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">片区指标 <em>{{ active ? '已选中' : '点击墙体选中' }}</em></div>
        <div class="scr-list">
          <div v-for="z in ZONES" :key="z.id" class="scr-item">
            <span>{{ z.name }}</span>
            <b>{{ z.value }}</b>
            <div class="scr-bar" :class="{ warn: z.value > 85 }">
              <i :style="{ width: `${z.value}%` }"></i>
            </div>
          </div>
        </div>
      </div>

      <div class="scr-tip">
        边界每段加厚成 18m 条带再拉伸 → 光墙；内层实墙 + 外层 12% 辉光叠加；高度按片区指标给
      </div>
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
  width: 218px;
}
.right {
  top: 76px;
  right: 16px;
  width: 196px;
}
</style>
