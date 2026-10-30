<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import { LineString, Point, Polygon } from 'ol/geom'
import { fromLonLat } from 'ol/proj'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: Map | null = null
type AnyLayer = VectorLayer<Feature>
const layers: Record<'area' | 'metro' | 'station', AnyLayer | null> = {
  area: null,
  metro: null,
  station: null,
}

const { current: currentBasemap, create: createBasemap, apply: applyBasemap } = useOlBasemap('dark')
const HOME = fromLonLat([116.397, 39.908])
const homeZoom = 11.4
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, HOME, homeZoom)

/** 图层开关状态 */
const visible = reactive({ area: true, metro: true, station: true })

const AREA_OPACITY = 0.32

function box(lon: number, lat: number, w: number, h: number): number[][] {
  return [
    [lon, lat],
    [lon + w, lat],
    [lon + w, lat + h],
    [lon, lat + h],
    [lon, lat],
  ].map(([x, y]) => fromLonLat([x, y]))
}

onMounted(() => {
  // ---- 面图层：几个商圈范围 ----
  const areaSource = new VectorSource<Feature>({
    features: [
      { name: '国贸 CBD', c: [116.443, 39.899], w: 0.044, h: 0.030 },
      { name: '王府井', c: [116.404, 39.908], w: 0.028, h: 0.020 },
      { name: '三里屯', c: [116.446, 39.930], w: 0.032, h: 0.022 },
      { name: '中关村', c: [116.302, 39.970], w: 0.046, h: 0.028 },
      { name: '金融街', c: [116.353, 39.909], w: 0.026, h: 0.019 },
    ].map(
      (a) =>
        new Feature({
          geometry: new Polygon([box(a.c[0], a.c[1], a.w, a.h)]),
          name: a.name,
        }),
    ),
  })

  layers.area = new VectorLayer({
    source: areaSource,
    style: (f) =>
      new Style({
        fill: new Fill({ color: `rgba(79,157,255,${AREA_OPACITY})` }),
        stroke: new Stroke({ color: 'rgba(120,190,255,0.9)', width: 1.4 }),
        text: new Text({
          text: (f.get('name') as string) ?? '',
          font: '600 11px sans-serif',
          fill: new Fill({ color: 'rgba(214,235,255,0.95)' }),
        }),
      }),
  })

  // ---- 线图层：地铁 1 号线示意 ----
  const metroLine: [number, number][] = [
    [116.307, 39.984], [116.335, 39.948], [116.356, 39.923], [116.383, 39.908],
    [116.411, 39.907], [116.44, 39.908], [116.462, 39.909], [116.49, 39.912],
    [116.529, 39.926], [116.561, 39.938], [116.6, 39.945], [116.631, 39.953],
    [116.66, 39.958], [116.704, 39.966], [116.735, 39.98],
  ]
  const metroSource = new VectorSource<Feature>({
    features: [
      new Feature({ geometry: new LineString(metroLine.map((p) => fromLonLat(p))), name: '1 号线' }),
    ],
  })
  layers.metro = new VectorLayer({
    source: metroSource,
    style: new Style({
      stroke: new Stroke({ color: '#ff5a5f', width: 3.4 }),
    }),
  })

  // ---- 点图层：站点 ----
  const stationNames = ['苹果园', '八宝山', '公主坟', '木樨地', '西单', '天安门西', '国贸', '大望路', '四惠']
  const stationSource = new VectorSource<Feature>({
    features: metroLine
      .filter((_, i) => i % 2 === 0)
      .map((p, i) =>
        new Feature({
          geometry: new Point(fromLonLat(p)),
          name: stationNames[i % stationNames.length],
        }),
      ),
  })
  layers.station = new VectorLayer({
    source: stationSource,
    style: (f) =>
      new Style({
        image: new CircleStyle({
          radius: 5,
          fill: new Fill({ color: '#ffffff' }),
          stroke: new Stroke({ color: '#ff5a5f', width: 2.6 }),
        }),
        text: new Text({
          text: (f.get('name') as string) ?? '',
          offsetY: 14,
          font: '500 10.5px sans-serif',
          fill: new Fill({ color: '#ffffff' }),
          stroke: new Stroke({ color: 'rgba(6,10,16,0.92)', width: 3 }),
        }),
      }),
  })

  map = new Map({
    target: container.value!,
    layers: [createBasemap(), layers.area!, layers.metro!, layers.station!],
    view: new View({ center: HOME, zoom: homeZoom, minZoom: 4, maxZoom: 18 }),
  })
})

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
})

function setBasemap(id: string) {
  applyBasemap(id)
}

function toggleLayer(key: 'area' | 'metro' | 'station') {
  visible[key] = !visible[key]
  layers[key]?.setVisible(visible[key])
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

    <div class="layer-panel">
      <div class="lp-title">图层控制</div>
      <button
        v-for="item in [
          { key: 'area' as const, name: '商圈范围', type: '面图层', color: '#4f9dff' },
          { key: 'metro' as const, name: '地铁线路', type: '线图层', color: '#ff5a5f' },
          { key: 'station' as const, name: '站点标注', type: '点图层', color: '#ffffff' },
        ]"
        :key="item.key"
        class="lp-item"
        @click="toggleLayer(item.key)"
      >
        <span class="lp-dot" :style="{ background: item.color, opacity: visible[item.key] ? 1 : 0.3 }"></span>
        <span class="lp-text">
          <b>{{ item.name }}</b>
          <i>{{ item.type }}</i>
        </span>
        <span class="lp-switch" :class="{ on: visible[item.key] }"><span class="knob"></span></span>
      </button>
    </div>

    <div class="tip">三个 VectorLayer 独立控制显隐，图层面板是 GIS 应用里最常见的交互控件。</div>
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
.layer-panel {
  position: absolute;
  top: 14px;
  right: 74px;
  z-index: 22;
  width: 196px;
  padding: 9px 8px 8px;
  border-radius: 11px;
  background: rgba(14, 20, 29, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.5);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(10px);
}
.lp-title {
  padding: 0 4px 7px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #8fa3b8;
}
.lp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.lp-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.lp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  transition: opacity 0.2s;
}
.lp-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.lp-text b {
  font-size: 12px;
  font-weight: 500;
  color: #e2ecf7;
}
.lp-text i {
  font-style: normal;
  font-size: 10px;
  color: #7b8b9c;
}
.lp-switch {
  position: relative;
  width: 30px;
  height: 17px;
  border-radius: 9px;
  background: rgba(120, 140, 160, 0.32);
  transition: background 0.2s;
  flex: none;
}
.lp-switch.on {
  background: rgba(79, 157, 255, 0.9);
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.lp-switch.on .knob {
  transform: translateX(13px);
}
.tip {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 12px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}
</style>
