<script setup lang="ts">
/**
 * 表达式与数据驱动样式
 * ===========================================================================
 * Mapbox 的样式不是写死的颜色，而是一门小型表达式语言（在 worker 里求值，不卡主线程）。
 * 本例把最常用的几类表达式做成可切换的预设，改一次就能看到画面差别：
 *
 *  | 表达式        | 作用                          | 典型场景              |
 *  |--------------|------------------------------|----------------------|
 *  | get          | 取要素属性                     | 一切数据驱动的基础     |
 *  | interpolate  | 连续插值（linear / exponential）| 数值 → 大小、颜色渐层 |
 *  | step         | 离散分档                       | 分级填色              |
 *  | match / case | 分类匹配 / 条件分支             | 类别 → 颜色，异常高亮 |
 *  | zoom         | 按层级驱动                     | 随缩放变化的符号大小   |
 *  | concat / \*  | 字符串拼接 / 数学运算           | 标注文本、字段换算     |
 *
 * 注意 `interpolate` 的插值基数写在最前面：`['interpolate', ['linear'], ['zoom'], ...]`
 * 第二项常被漏掉，漏了整个表达式会被判非法，图层静默不画。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap, ExpressionSpecification } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { CITIES, fc, feat } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const HOME = { center: [113.9, 32.6] as [number, number], zoom: 4 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

type Preset = {
  id: string
  label: string
  note: string
  radius: ExpressionSpecification
  color: ExpressionSpecification
}

const PRESETS: Preset[] = [
  {
    id: 'zoom',
    label: '① zoom 驱动半径',
    note: '半径随层级从 3px 长到 18px，颜色固定',
    radius: ['interpolate', ['linear'], ['zoom'], 3, 3, 9, 18],
    color: ['literal', '#4f9dff'],
  },
  {
    id: 'linear',
    label: '② 属性线性插值',
    note: '半径 = f(指标值)，颜色按值做蓝→黄渐变',
    radius: ['interpolate', ['linear'], ['get', 'v'], 20, 4, 100, 22],
    color: [
      'interpolate',
      ['linear'],
      ['get', 'v'],
      20,
      '#2b6cb0',
      60,
      '#4f9dff',
      100,
      '#ffd166',
    ],
  },
  {
    id: 'exp',
    label: '③ 指数插值',
    note: '面积型数值用指数 0.5 插值，视觉面积才与数值成正比',
    radius: ['interpolate', ['exponential', 0.5], ['get', 'v'], 20, 4, 100, 26],
    color: ['interpolate', ['exponential', 0.5], ['get', 'v'], 20, '#1f6feb', 100, '#ff6b6b'],
  },
  {
    id: 'step',
    label: '④ step 分档',
    note: '三档阈值 45 / 70，档内同色',
    radius: ['step', ['get', 'v'], 5, 45, 9, 70, 15],
    color: ['step', ['get', 'v'], '#5aa9e6', 45, '#ffd166', 70, '#ff6b6b'],
  },
  {
    id: 'case',
    label: '⑤ case 条件分支',
    note: '指标 ≥ 80 标红并放大，其余按等级取色',
    radius: ['case', ['>=', ['get', 'v'], 80], 16, ['>=', ['get', 'v'], 50], 10, 6],
    color: ['case', ['>=', ['get', 'v'], 80], '#ff6b6b', ['>=', ['get', 'v'], 50], '#ffd166', '#7fb8ff'],
  },
  {
    id: 'concat',
    label: '⑥ 数学 + 文本拼接',
    note: '标注为「名 / 值×1.5」，半径用乘除换算',
    radius: ['/', ['*', ['get', 'v'], 1.5], 6],
    color: [
      'match',
      ['get', 'name'],
      ['北京', '上海', '深圳'],
      '#ff6b6b',
      ['杭州', '南京', '苏州'],
      '#ffd166',
      '#7fb8ff',
    ],
  },
]

const active = ref('linear')

function radiusExpr(): ExpressionSpecification {
  return (PRESETS.find((p) => p.id === active.value) ?? PRESETS[1]).radius
}
function colorExpr(): ExpressionSpecification {
  return (PRESETS.find((p) => p.id === active.value) ?? PRESETS[1]).color
}

function build() {
  if (!map) return
  map.addSource('cities', {
    type: 'geojson',
    data: fc(
      CITIES.map((c) =>
        feat({ type: 'Point', coordinates: c.c }, { name: c.name, v: c.v }),
      ),
    ),
  })
  map.addLayer({
    id: 'cities',
    type: 'circle',
    source: 'cities',
    paint: {
      'circle-radius': radiusExpr(),
      'circle-color': colorExpr(),
      'circle-opacity': 0.85,
      'circle-stroke-width': 1.2,
      'circle-stroke-color': 'rgba(8,14,22,0.8)',
    },
  })
  map.addLayer({
    id: 'cities-label',
    type: 'symbol',
    source: 'cities',
    layout: {
      // concat 把属性拼成一句标注；数学表达式先算再转字符串
      'text-field': [
        'concat',
        ['get', 'name'],
        ' / ',
        ['to-string', ['round', ['*', ['get', 'v'], 1.5]]],
      ],
      'text-font': [MB_FONT],
      'text-size': 11.5,
      'text-offset': [0, 0.1],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#eaf2fb',
      'text-halo-color': 'rgba(6,12,22,0.9)',
      'text-halo-width': 1.4,
    },
  })
}

function pick(id: string) {
  active.value = id
  if (!map) return
  map.setPaintProperty('cities', 'circle-radius', radiusExpr())
  map.setPaintProperty('cities', 'circle-color', colorExpr())
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
      <h4>样式表达式</h4>
      <button
        v-for="p in PRESETS"
        :key="p.id"
        class="mb-btn item"
        :class="{ on: active === p.id }"
        @click="pick(p.id)"
      >
        {{ p.label }}
      </button>
      <div class="hint">{{ PRESETS.find((p) => p.id === active)?.note }}</div>
    </div>
    <div class="mb-tip">切换预设看 setPaintProperty 实时改表达式的效果</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 216px;
}
.item {
  display: block;
  width: 100%;
  margin-bottom: 5px;
  text-align: left;
}
.hint {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.55;
}
</style>
