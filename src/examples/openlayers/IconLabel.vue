<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { Point } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { Icon, Style, Fill, Stroke, Text } from 'ol/style'
import type { FeatureLike } from 'ol/Feature'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const hoverName = ref('—')
let map: Map | null = null
let hovered: Feature<Point> | null = null

const { current: currentBasemap, create: createBasemap, apply: applyBasemap } = useOlBasemap()
const HOME = fromLonLat([120.16, 30.28])
const homeZoom = 12.2
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, HOME, homeZoom)

type Kind = 'hospital' | 'school' | 'mall'

const KIND_DEF: Record<Kind, { color: string; glyph: string; label: string }> = {
  hospital: { color: '#ff5a5f', glyph: '✚', label: '医院' },
  school: { color: '#4f9dff', glyph: 'A', label: '学校' },
  mall: { color: '#ffc46b', glyph: '¥', label: '商场' },
}

/** 用内联 SVG 生成地图图标，避免依赖外部图片资源 */
function iconUrl(kind: Kind): string {
  const { color, glyph } = KIND_DEF[kind]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">
    <path d="M17 42.2C17 42.2 32 26 32 16.4C32 7.6 25.3 1.4 17 1.4C8.7 1.4 2 7.6 2 16.4C2 26 17 42.2 17 42.2Z"
      fill="${color}" stroke="#0b1220" stroke-width="2"/>
    <circle cx="17" cy="16" r="8.6" fill="rgba(255,255,255,0.94)"/>
    <text x="17" y="20.4" text-anchor="middle" font-family="sans-serif" font-size="11"
      font-weight="700" fill="${color}">${glyph}</text>
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const ICONS: Record<Kind, Icon> = {
  hospital: new Icon({ src: iconUrl('hospital'), anchor: [0.5, 1], scale: 1 }),
  school: new Icon({ src: iconUrl('school'), anchor: [0.5, 1], scale: 1 }),
  mall: new Icon({ src: iconUrl('mall'), anchor: [0.5, 1], scale: 1 }),
}

/** 悬停时放大的同一套图标 */
const ICONS_HOVER: Record<Kind, Icon> = {
  hospital: new Icon({ src: iconUrl('hospital'), anchor: [0.5, 1], scale: 1.28 }),
  school: new Icon({ src: iconUrl('school'), anchor: [0.5, 1], scale: 1.28 }),
  mall: new Icon({ src: iconUrl('mall'), anchor: [0.5, 1], scale: 1.28 }),
}

const POIS: { name: string; kind: Kind; lon: number; lat: number }[] = [
  { name: '市第一人民医院', kind: 'hospital', lon: 120.166, lat: 30.286 },
  { name: '邵逸夫医院', kind: 'hospital', lon: 120.192, lat: 30.257 },
  { name: '浙大附属二院', kind: 'hospital', lon: 120.152, lat: 30.252 },
  { name: '浙江大学', kind: 'school', lon: 120.128, lat: 30.263 },
  { name: '杭州高级中学', kind: 'school', lon: 120.171, lat: 30.271 },
  { name: '浙江工业大学', kind: 'school', lon: 120.152, lat: 30.301 },
  { name: '学军中学', kind: 'school', lon: 120.135, lat: 30.278 },
  { name: '湖滨银泰 in77', kind: 'mall', lon: 120.163, lat: 30.256 },
  { name: '万象城', kind: 'mall', lon: 120.209, lat: 30.245 },
  { name: '武林银泰', kind: 'mall', lon: 120.169, lat: 30.272 },
  { name: '西溪印象城', kind: 'mall', lon: 120.098, lat: 30.277 },
]

/** 样式函数：图标 + 文字标注（带描边背景，保证任何底图上都清晰） */
function poiStyle(feature: FeatureLike): Style {
  const kind = (feature.get('kind') as Kind) ?? 'mall'
  const isHover = feature === hovered
  return new Style({
    image: isHover ? ICONS_HOVER[kind] : ICONS[kind],
    text: new Text({
      text: (feature.get('name') as string) ?? '',
      font: '600 11.5px sans-serif',
      offsetY: isHover ? -52 : -46,
      fill: new Fill({ color: '#ffffff' }),
      backgroundFill: new Fill({ color: 'rgba(9,14,21,0.78)' }),
      backgroundStroke: new Stroke({ color: 'rgba(255,255,255,0.16)', width: 1 }),
      padding: [3, 6, 3, 6],
    }),
    zIndex: (kind === 'hospital' ? 3 : 2) + (isHover ? 10 : 0),
  })
}

onMounted(() => {
  const source = new VectorSource({
    features: POIS.map(
      (p) =>
        new Feature({
          geometry: new Point(fromLonLat([p.lon, p.lat])),
          name: p.name,
          kind: p.kind,
        }),
    ),
  })

  const layer = new VectorLayer({
    source,
    style: poiStyle,
    declutter: true,
    updateWhileAnimating: true,
  })

  map = new Map({
    target: container.value!,
    layers: [createBasemap(), layer],
    view: new View({ center: HOME, zoom: homeZoom, minZoom: 4, maxZoom: 18 }),
  })

  // 悬停高亮：把光标移到要素上时放大图标
  map.on('pointermove', (evt) => {
    const hit = map!.forEachFeatureAtPixel(evt.pixel, (f) => f as Feature<Point>) || null
    if (hit !== hovered) {
      hovered = hit
      hoverName.value = hit ? ((hit.get('name') as string) ?? '—') : '—'
      layer.changed()
      const target = map!.getTargetElement()
      if (target) target.style.cursor = hit ? 'pointer' : ''
    }
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
  hovered = null
})

function setBasemap(id: string) {
  applyBasemap(id)
}
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>
    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="setBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="legend">
      <div class="lg-title">POI 图标标注</div>
      <div class="lg-row">
        <span class="dot" style="background: #ff5a5f"></span><span>医院</span>
        <span class="dot" style="background: #4f9dff"></span><span>学校</span>
        <span class="dot" style="background: #ffc46b"></span><span>商场</span>
      </div>
      <div class="lg-hover">当前悬停：<b>{{ hoverName }}</b></div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.ol-container {
  width: 100%;
  height: 100%;
}
.legend {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  padding: 9px 13px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  backdrop-filter: blur(8px);
}
.lg-title {
  font-size: 12px;
  font-weight: 600;
  color: #e6eef7;
}
.lg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  font-size: 11.5px;
  color: #b9c8d8;
}
.lg-row .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 6px;
}
.lg-row .dot:first-child {
  margin-left: 0;
}
.lg-hover {
  margin-top: 7px;
  font-size: 11.5px;
  color: #8b9aab;
}
.lg-hover b {
  color: #4f9dff;
  font-weight: 600;
}
</style>
