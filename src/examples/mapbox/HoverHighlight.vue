<script setup lang="ts">
/**
 * 悬停高亮与列表联动
 * ===========================================================================
 * 地图 + 侧栏列表的组合在做看板时几乎必现，联动的核心是 **feature-state**：
 *
 *  - `setFeatureState({ source, id }, { hover: true })` 只改渲染状态，不动数据，
 *    比每次 hover 都 setData 快得多；
 *  - 样式里用 `['boolean', ['feature-state', 'hover'], false]` 读状态，
 *    必须给默认值 false，否则未设置的要素会取到 null 导致表达式判非法；
 *  - source 要开 `generateId: true`，否则要素没有 id，setFeatureState 无从下手；
 *  - 双向联动：地图 hover → 高亮列表项（并 scrollIntoView）；
 *    列表 hover → 高亮地图要素（并 flyTo 到该点）。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { CITIES, fc, feat } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const hoverName = ref('')
const listRef = ref<HTMLDivElement>()
let map: MbMap | null = null
let hovered: number | null = null

const HOME = { center: [113.9, 32.5] as [number, number], zoom: 4 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** id 用数组下标，和 generateId 生成的 id 保持一致（GeoJSON 顺序即 id 顺序） */
const DATA = fc(
  CITIES.map((c, i) =>
    feat({ type: 'Point', coordinates: c.c }, { name: c.name, v: c.v, idx: i }),
  ),
)

function build() {
  if (!map) return
  map.addSource('cities', { type: 'geojson', data: DATA, generateId: true })

  map.addLayer({
    id: 'cities',
    type: 'circle',
    source: 'cities',
    paint: {
      'circle-radius': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        14,
        ['interpolate', ['linear'], ['get', 'v'], 20, 5, 100, 13],
      ],
      'circle-color': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        '#ffd166',
        ['interpolate', ['linear'], ['get', 'v'], 20, '#2b6cb0', 100, '#7fb8ff'],
      ],
      'circle-stroke-width': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        2.5,
        1.2,
      ],
      'circle-stroke-color': 'rgba(255,255,255,0.75)',
    },
  })
  map.addLayer({
    id: 'cities-text',
    type: 'symbol',
    source: 'cities',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      // 注意：layout 属性不支持 feature-state（只有 paint 支持），所以文字高亮用颜色表达
      'text-size': 11.5,
      'text-offset': [0, 1],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        '#ffd166',
        '#eaf2fb',
      ],
      'text-halo-color': 'rgba(6,12,22,0.9)',
      'text-halo-width': 1.4,
    },
  })

  map.on('mousemove', 'cities', (e) => {
    if (!map || !e.features?.length) return
    const f = e.features[0]
    const id = f.id as number
    setHover(id, (f.properties?.name as string) ?? '')
  })
  map.on('mouseleave', 'cities', () => setHover(null, ''))
  map.on('click', 'cities', (e) => {
    const f = e.features?.[0]
    if (!f || !map) return
    map.flyTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: 9, duration: 900 })
  })
}

function setHover(id: number | null, name: string) {
  if (!map) return
  if (hovered !== null && hovered !== id) {
    map.setFeatureState({ source: 'cities', id: hovered }, { hover: false })
  }
  hovered = id
  hoverName.value = name
  if (id !== null) {
    map.setFeatureState({ source: 'cities', id }, { hover: true })
    // 列表项跟着滚到可视区
    const el = listRef.value?.querySelector(`[data-idx="${id}"]`)
    el?.scrollIntoView({ block: 'nearest' })
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
    <div ref="listRef" class="mb-panel list">
      <h4>城市（{{ DATA.features.length }}）</h4>
      <div class="scroll">
        <div
          v-for="(c, i) in CITIES"
          :key="c.name"
          class="li"
          :data-idx="i"
          :class="{ on: hoverName === c.name }"
          @mouseenter="setHover(i, c.name)"
          @mouseleave="setHover(null, '')"
          @click="map?.flyTo({ center: c.c, zoom: 9, duration: 900 })"
        >
          <span>{{ c.name }}</span>
          <b>{{ c.v }}</b>
        </div>
      </div>
    </div>
    <div class="mb-tip">
      {{ hoverName ? `高亮：${hoverName}` : '鼠标划过地图或列表，两边同时高亮 · 点击飞入' }}
    </div>
  </div>
</template>

<style scoped>
.list {
  top: 14px;
  left: 14px;
  width: 176px;
}
.scroll {
  max-height: 320px;
  overflow: auto;
}
.li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 5px;
  font-size: 11.5px;
  color: #a9bccf;
  cursor: pointer;
}
.li:hover,
.li.on {
  background: rgba(79, 157, 255, 0.22);
  color: #eaf2fb;
}
.li b {
  font-variant-numeric: tabular-nums;
}
</style>
