<script setup lang="ts">
/**
 * 建筑按年份生长（时间轴回放）
 * ===========================================================================
 * 三个技巧叠在一起才是「长出来」的效果，少一个都会变成「突然冒出来」：
 *  1) filter：只画 year <= 当前年份的楼 —— 未建成的楼不存在；
 *  2) feature-state：当年新增的楼把 grow 从 0 推到 1，高度按 grow 插值 —— 一栋栋长高；
 *  3) 已经长成的楼不再逐帧写 state，只有正在生长的那几十栋在变 —— 性能才扛得住。
 *
 * 注意：feature-state 只能用在 paint 属性上，fill-extrusion-height 是 paint，可以用；
 * 但 filter 里不能用 feature-state，所以「建成与否」走 filter、「生长进度」走 state。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import { createMap, useMapboxView, dimBasemap, swapBasemap } from './useMapbox'
import { MB_BASEMAPS } from './basemaps'
import MapControls from '@/components/MapControls.vue'
import { feat, fc, mulberry32 } from './data'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const base = ref('dark')
const playing = ref(true)
const year = ref(2012)
const total = ref(0)
const built = ref(0)
const fresh = ref(0)
let map: MbMap | null = null
let raf = 0

const YEAR_MIN = 2012
const YEAR_MAX = 2026
const SPEED = 0.42 // 年/秒（真实时间），14 年 ≈ 33 秒一轮

/** 钱江新城：越新的楼越高，天际线随时间「长起来」 */
const HOME = { center: [120.2135, 30.2405] as [number, number], zoom: 13.4, pitch: 58, bearing: -18 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

interface Building {
  year: number
  height: number
}
const list: Building[] = []

function cityData() {
  const rnd = mulberry32(2027)
  const out: GeoJSON.Feature[] = []
  const cell = 0.00135
  const nx = 13
  const ny = 10
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const pad = cell * (0.16 + rnd() * 0.18)
      const x0 = HOME.center[0] - (nx * cell) / 2 + i * cell + pad
      const y0 = HOME.center[1] - (ny * cell) / 2 + j * cell + pad * 0.8
      const x1 = x0 + cell - pad * 2
      const y1 = y0 + cell * 0.78 - pad * 1.6
      // 建成时间：越靠中心越早建成（CBD 先起来，外围后来跟进）
      const d = Math.hypot(i - nx / 2, j - ny / 2) / nx
      const bias = Math.min(0.85, d * 1.5)
      const y = Math.min(
        YEAR_MAX,
        YEAR_MIN + Math.floor((rnd() * 0.62 + bias * 0.62) * (YEAR_MAX - YEAR_MIN + 1)),
      )
      // 高度与建成年代正相关：早建的多层，晚建的超高层
      const h = Math.round(18 + (y - YEAR_MIN) * 11 + rnd() * 70)
      list.push({ year: y, height: h })
      out.push(
        feat(
          {
            type: 'Polygon',
            coordinates: [
              [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
                [x0, y0],
              ],
            ],
          },
          { year: y, height: h },
        ),
      )
    }
  }
  total.value = out.length
  return fc(out)
}

/** 当前年份正在生长的楼（index, 进度） */
function growingIds(y: number) {
  const cur = Math.floor(y)
  const frac = y - cur
  const ids: number[] = []
  for (let i = 0; i < list.length; i++) if (list[i].year === cur) ids.push(i)
  return { ids, frac }
}

function applyYear(y: number) {
  if (!map) return
  const cur = Math.floor(y)
  // 1) 只保留已建成的楼
  if (map.getLayer('buildings')) {
    map.setFilter('buildings', ['<=', ['get', 'year'], cur])
    map.setFilter('buildings-cap', ['<=', ['get', 'year'], cur])
    map.setFilter('lots', ['<=', ['get', 'year'], cur])
  }

  // 2) 当年那批楼逐栋长高
  const { ids, frac } = growingIds(y)
  for (const id of ids) {
    map.setFeatureState({ source: 'city', id }, { grow: Math.max(0.02, frac) })
  }
  // 3) 上一年那批收尾（补齐 1，避免停在 0.98）
  if (frac < 0.05) {
    for (const id of ids) map.setFeatureState({ source: 'city', id }, { grow: 1 })
  }

  built.value = list.filter((b) => b.year <= cur).length
  fresh.value = ids.length
}

function build() {
  if (!map) return
  dimBasemap(map!, 0.42)

  map.addSource('city', { type: 'geojson', data: cityData(), generateId: true })

  // 未建成地块（暗色底片，暗示「这里将来会有楼」）
  map.addLayer({
    id: 'lots',
    source: 'city',
    type: 'fill',
    paint: { 'fill-color': '#0e1a26', 'fill-opacity': 0.55 },
  })

  // 楼体
  map.addLayer({
    id: 'buildings',
    source: 'city',
    type: 'fill-extrusion',
    paint: {
      // feature-state 缺省为 1（已建成的楼直接全高）
      'fill-extrusion-height': [
        '*',
        ['get', 'height'],
        ['coalesce', ['feature-state', 'grow'], 1],
      ],
      'fill-extrusion-base': 0,
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['get', 'year'],
        YEAR_MIN,
        '#173649',
        2018,
        '#1f6f8c',
        2022,
        '#35b6c9',
        YEAR_MAX,
        '#ffd166',
      ],
      'fill-extrusion-opacity': 0.95,
      'fill-extrusion-vertical-gradient': true,
    },
  })

  // 顶面描边：强调当前年份新长出来的楼
  map.addLayer({
    id: 'buildings-cap',
    source: 'city',
    type: 'line',
    paint: {
      'line-color': [
        'case',
        ['==', ['get', 'year'], Math.floor(year.value)],
        '#ffd166',
        '#5fd8ff',
      ],
      'line-width': ['case', ['==', ['get', 'year'], Math.floor(year.value)], 1.8, 0.4],
      'line-opacity': 0.7,
    },
  })

  applyYear(year.value)
}

onMounted(() => {
  map = createMap(container.value!, { style: 'dark', ...HOME })
  map.on('load', () => {
    build()
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (!playing.value) return
      year.value += SPEED / 60
      if (year.value >= YEAR_MAX + 1) year.value = YEAR_MIN
      applyYear(year.value)
    }
    loop()
  })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  map?.remove()
  map = null
})

function setYear(v: number) {
  year.value = v
  playing.value = false
  // 手动拖动时，把历史进度一次性补齐（否则旧楼可能停在生长中途）
  if (!map) return
  for (let i = 0; i < list.length; i++) {
    if (list[i].year < Math.floor(v)) map.setFeatureState({ source: 'city', id: i }, { grow: 1 })
  }
  applyYear(v)
}
function togglePlay() {
  playing.value = !playing.value
}
function setBasemap(id: string) {
  base.value = id
  if (!map) return
  // 换底图会重建 style：图层要重新加，feature-state 也要按当前年份补齐
  swapBasemap(map, id, () => {
    build()
    const cur = Math.floor(year.value)
    for (let i = 0; i < list.length; i++) {
      if (list[i].year <= cur - 1) map!.setFeatureState({ source: 'city', id: i }, { grow: 1 })
    }
  })
}
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>
    <MapControls
      :basemaps="MB_BASEMAPS"
      :model-value="base"
      @update:model-value="setBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="hud">
      <div class="year">{{ Math.floor(year) }}</div>
      <div class="sub">
        已建成 <b>{{ built }}</b> / {{ total }} 栋 · 本年新增 <b class="fresh">{{ fresh }}</b>
      </div>
    </div>

    <div class="timeline">
      <button class="play" @click="togglePlay">{{ playing ? '❚❚' : '▶' }}</button>
      <input
        class="range"
        type="range"
        :min="YEAR_MIN"
        :max="YEAR_MAX + 1"
        step="0.02"
        :value="year"
        @input="setYear(Number(($event.target as HTMLInputElement).value))"
      />
      <span class="range-year">{{ Math.floor(year) }}</span>
    </div>

    <div class="mb-tip">
      钱江新城 {{ total }} 栋楼 · 越新的楼越高，颜色由青转金 · 拖动时间轴可回看任意年份
    </div>
  </div>
</template>

<style scoped>
.hud {
  position: absolute;
  top: 18px;
  left: 18px;
  z-index: 5;
  pointer-events: none;
}
.year {
  font-size: 54px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 2px;
  color: #eaf6ff;
  text-shadow: 0 0 22px rgba(80, 200, 255, 0.65);
  font-variant-numeric: tabular-nums;
}
.sub {
  margin-top: 8px;
  font-size: 12.5px;
  color: #9fb0c2;
}
.sub b {
  color: #7ee787;
  font-weight: 600;
}
.sub b.fresh {
  color: #ffd166;
}
.timeline {
  position: absolute;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(620px, 70%);
  padding: 10px 16px;
  border-radius: 999px;
  background: rgba(12, 20, 30, 0.82);
  border: 1px solid rgba(90, 110, 135, 0.45);
  backdrop-filter: blur(10px);
}
.play {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid rgba(110, 190, 255, 0.6);
  background: rgba(30, 80, 130, 0.6);
  color: #cfe9ff;
  font-size: 12px;
  cursor: pointer;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.range-year {
  font-size: 13px;
  color: #7ee787;
  width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
