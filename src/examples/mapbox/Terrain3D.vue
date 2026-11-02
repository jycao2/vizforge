<script setup lang="ts">
/**
 * 三维地形与晕渲
 * ===========================================================================
 * 两件事，别混为一谈：
 *
 *  1) `raster-dem` source + `setTerrain()` —— 真正的三维起伏，地形参与深度与遮挡；
 *  2) `hillshade` 图层 —— 二维的山体阴影渲染，即使不加 terrain 也能单独用，
 *     放在平面底图上做"浮雕效果"很常见。
 *
 * 本例两个都开：DEM 用 AWS 的 terrarium 公开高程瓦片（免 Token、带 CORS），
 * 它的编码规则是 `h = (R*256 + G + B/256) - 32768`，style 里写 encoding: 'terrarium'
 * 让 Mapbox 自己解码。
 *
 * 参数说明：
 *  - exaggeration：地形夸张倍数，平原地区常用 1.5~3 才看得出起伏；
 *  - hillshade-shadow-color / highlight-color：阴阳坡配色；
 *  - hillshade-exaggeration：晕渲的夸张，和 terrain 的夸张是两套参数。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_BASEMAPS, rasterStyle } from './basemaps'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const exag = ref(1.6)
const hillOn = ref(true)
const terrainOn = ref(true)
const base = ref('dark')
let map: MbMap | null = null

/** 黄山：起伏明显，适合看地形 */
const HOME = { center: [118.167, 30.133] as [number, number], zoom: 11.4, pitch: 68, bearing: 25 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

function build() {
  if (!map) return
  map.addSource('dem', {
    type: 'raster-dem',
    tiles: [DEM_URL],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 14,
    attribution: '高程 © Mapzen / AWS Terrain Tiles',
  })

  map.addLayer({
    id: 'hillshade',
    source: 'dem',
    type: 'hillshade',
    paint: {
      'hillshade-shadow-color': '#0a1524',
      'hillshade-highlight-color': '#8fb7d8',
      'hillshade-accent-color': '#2a3f58',
      'hillshade-exaggeration': 0.55,
      'hillshade-illumination-direction': 335,
    },
  })

  map.setTerrain({ source: 'dem', exaggeration: exag.value })
}

function setExag(v: number) {
  exag.value = v
  map?.setTerrain({ source: 'dem', exaggeration: v })
}

function toggleTerrain() {
  terrainOn.value = !terrainOn.value
  if (!map) return
  if (terrainOn.value) map.setTerrain({ source: 'dem', exaggeration: exag.value })
  else map.setTerrain(null)
}

function toggleHill() {
  hillOn.value = !hillOn.value
  if (!map || !map.getLayer('hillshade')) return
  map.setLayoutProperty('hillshade', 'visibility', hillOn.value ? 'visible' : 'none')
}

/**
 * 换底图：setStyle 会把 dem/hillshade 一起清掉，所以必须在 style.load 后重建，
 * 还要重新 setTerrain —— 这是所有"有业务图层的地图换底图"都要走的标准流程。
 */
function setBasemap(id: string) {
  if (!map) return
  base.value = id
  map.setStyle(rasterStyle(id))
  map.once('style.load', () => {
    build()
    // 地形默认是关的，换完 style 要按当前开关补回来
    if (!terrainOn.value) map?.setTerrain(null)
    if (!hillOn.value && map?.getLayer('hillshade')) {
      map.setLayoutProperty('hillshade', 'visibility', 'none')
    }
  })
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
      :basemaps="MB_BASEMAPS"
      :model-value="base"
      @update:model-value="setBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-panel ctrl">
      <h4>地形</h4>
      <label class="mb-row">
        <span>夸张</span>
        <input
          type="range"
          min="1"
          max="4"
          step="0.1"
          :value="exag"
          @input="setExag(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ exag.toFixed(1) }}×</b>
      </label>
      <label class="mb-row">
        <input v-model="terrainOn" type="checkbox" @change="toggleTerrain" />
        <span>三维起伏（terrain）</span>
      </label>
      <label class="mb-row">
        <input v-model="hillOn" type="checkbox" @change="toggleHill" />
        <span>山体阴影（hillshade）</span>
      </label>
      <div class="hint">DEM：AWS terrarium 公开高程瓦片，免 Token</div>
    </div>
    <div class="mb-tip">黄山 · 倾角 68° · 右键拖拽换方位看阴阳坡</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 226px;
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
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
