<script setup lang="ts">
/**
 * 真三维地形 + 建筑
 * ===========================================================================
 * 地形（raster-dem + setTerrain）打开后，fill-extrusion 会自动以地形高度为基准
 * 向上拉伸，楼块与山体互相遮挡 —— 平面地图上那种「楼浮在空中」的感觉消失。
 *
 * 三个只有开了地形才会遇到的点：
 *  1) 楼块 base 必须留 0，让 MapLibre 用地形高度兜底；写死 base=0 米会把山上的楼埋掉。
 *  2) 地形瓦片是异步的，首次 setTerrain 后山体要一两秒才「长」出来，加载期先别改视角。
 *  3) 开了 terrain 的相机在 pitch 很高时容易穿山，maxPitch 与 far 要给够。
 *
 * 城市选重庆：沿江两岸高差近 200m，最能体现「楼顺着山势长」。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import { createMap, useMapboxView, dimBasemap, swapBasemap } from './useMapbox'
import { MB_BASEMAPS } from './basemaps'
import { blocks, fc, feat } from './data'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const base = ref('dark')
const exag = ref(1.6)
const heightScale = ref(1)
const terrainOn = ref(true)
const buildings = ref(0)
let map: MbMap | null = null

/** 重庆渝中半岛 */
const HOME = { center: [106.575, 29.5605] as [number, number], zoom: 12.6, pitch: 68, bearing: -22 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

/** 沿江两岸三片建筑群（用 blocks 生成，再补一层江边小体量） */
function cityData() {
  const parts = [
    blocks([106.562, 29.5535], 9, 7, 0.0016, 31), // 江北嘴
    blocks([106.5785, 29.5615], 8, 8, 0.0015, 37), // 解放碑
    blocks([106.588, 29.548], 7, 6, 0.0017, 43), // 南岸
  ]
  const all: GeoJSON.Feature[] = []
  for (const p of parts) all.push(...p.features)
  // 江边低矮建筑带，让高差层次更明显
  const rnd = (seed => {
    let a = seed
    return () => {
      a = (a * 1664525 + 1013904223) % 4294967296
      return a / 4294967296
    }
  })(19)
  for (let i = 0; i < 40; i++) {
    const lon = 106.5705 + rnd() * 0.012
    const lat = 29.5555 + rnd() * 0.004
    const s = 0.0003 + rnd() * 0.0003
    all.push(
      feat(
        {
          type: 'Polygon',
          coordinates: [[[lon, lat], [lon + s, lat], [lon + s, lat + s * 0.8], [lon, lat + s * 0.8], [lon, lat]]],
        },
        { height: 12 + rnd() * 26 },
      ),
    )
  }
  buildings.value = all.length
  return fc(all)
}

function build() {
  if (!map) return
  dimBasemap(map!, 0.5)

  map.addSource('dem', {
    type: 'raster-dem',
    tiles: [DEM_URL],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 14,
    attribution: '高程 © Mapzen / AWS Terrain Tiles',
  })

  // 山体阴影：即使不转视角也能看出沟谷走向
  map.addLayer({
    id: 'hillshade',
    source: 'dem',
    type: 'hillshade',
    paint: {
      'hillshade-shadow-color': '#050a12',
      'hillshade-highlight-color': '#7fa6c8',
      'hillshade-accent-color': '#1b2c3d',
      'hillshade-exaggeration': 0.6,
      'hillshade-illumination-direction': 320,
    },
  })

  map.addSource('city', { type: 'geojson', data: cityData() })

  // 楼块：高度按地形为基准自动抬升
  map.addLayer({
    id: 'buildings',
    source: 'city',
    type: 'fill-extrusion',
    paint: {
      'fill-extrusion-height': ['*', ['get', 'height'], heightScale.value],
      'fill-extrusion-base': 0,
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['get', 'height'],
        10,
        '#1d3a52',
        60,
        '#2f6f96',
        140,
        '#59b7d8',
        240,
        '#a8e4f5',
      ],
      'fill-extrusion-opacity': 0.94,
      'fill-extrusion-vertical-gradient': true,
    },
  })

  // 顶面轮廓光：little 技巧 —— 同一份数据再画一遍描边，勾出屋顶
  map.addLayer({
    id: 'building-outline',
    source: 'city',
    type: 'line',
    paint: { 'line-color': '#8fe6ff', 'line-width': 0.5, 'line-opacity': 0.35 },
  })

  if (terrainOn.value) map.setTerrain({ source: 'dem', exaggeration: exag.value })

  // 天空与雾，让远山有远近层次
  map.setSky({
    'sky-color': '#0a1420',
    'sky-horizon-blend': 0.55,
    'horizon-color': '#20364d',
    'horizon-fog-blend': 0.6,
    'fog-color': '#0b1622',
    'fog-ground-blend': 0.7,
  })
}

onMounted(() => {
  map = createMap(container.value!, {
    style: 'dark',
    ...HOME,
  })
  map.on('load', build)
})

onBeforeUnmount(() => {
  map?.remove()
  map = null
})

function setExag(v: number) {
  exag.value = v
  if (!map || !terrainOn.value) return
  map.setTerrain({ source: 'dem', exaggeration: v })
}
function setHeightScale(v: number) {
  heightScale.value = v
  if (map?.getLayer('buildings')) {
    map.setPaintProperty('buildings', 'fill-extrusion-height', ['*', ['get', 'height'], v])
  }
}
function setBasemap(id: string) {
  base.value = id
  if (!map) return
  swapBasemap(map, id, () => {
    build()
  })
}

function toggleTerrain() {
  terrainOn.value = !terrainOn.value
  if (!map) return
  if (terrainOn.value) map.setTerrain({ source: 'dem', exaggeration: exag.value })
  else map.setTerrain(null)
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
    <div class="mb-panel ctrl">
      <h4>三维地形 + 建筑</h4>
      <label class="mb-row">
        <span>地形夸张</span>
        <input
          type="range"
          min="0.6"
          max="3"
          step="0.1"
          :value="exag"
          @input="setExag(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ exag.toFixed(1) }}×</b>
      </label>
      <label class="mb-row">
        <span>楼高倍数</span>
        <input
          type="range"
          min="0.3"
          max="2.2"
          step="0.05"
          :value="heightScale"
          @input="setHeightScale(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ heightScale.toFixed(2) }}</b>
      </label>
      <label class="mb-row">
        <input v-model="terrainOn" type="checkbox" @change="toggleTerrain" />
        <span>三维起伏（terrain）</span>
      </label>
      <div class="hint">渝中半岛 {{ buildings }} 栋 · DEM 与楼块共享同一地形基准</div>
    </div>
    <div class="mb-tip">重庆 · 山坡上的楼块 base 交给地形，倾角 68° 看楼与山体互相遮挡</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 244px;
}
.mb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  margin: 6px 0;
}
.mb-row input[type='range'] {
  flex: 1;
  accent-color: #4f9dff;
}
.mb-row b {
  color: #7ee787;
  font-weight: 500;
  min-width: 42px;
  text-align: right;
}
.hint {
  margin-top: 6px;
  font-size: 11.5px;
  color: #8b9aab;
}
</style>
