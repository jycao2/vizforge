<script setup lang="ts">
/**
 * 导出图片
 * ===========================================================================
 * 把当前地图画面导出成 PNG / JPEG。看似一行 toDataURL，实际有两个坑：
 *
 *  1) **必须开 preserveDrawingBuffer**：WebGL 默认在绘制完成后清空后台缓冲区，
 *     你在任意时刻读 canvas 拿到的都是空白。只有建图时传 `preserveDrawingBuffer: true`
 *     才能随时取到内容（代价是略高的显存占用）。
 *  2) **时机**：要导出的内容必须先渲染完。稳妥做法是监听 `idle`
 *     （地图渲染空闲）后再取，本例的"导出"按钮会先等一帧 idle。
 *
 * 另外：Mapbox 的控件（Navigation / Scale / Attribution）是 DOM，
 * 不会出现在 canvas 截图里，所以导出的图是"纯净"的地图画面 ——
 * 想带图例就得自己用 canvas 画上去（本例演示了叠加标题与图例的做法）。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { CITIES, fc, feat } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const preview = ref('')
const note = ref('')
const withLegend = ref(true)
let map: MbMap | null = null

const HOME = { center: [113.9, 32.6] as [number, number], zoom: 3.9 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

function build() {
  if (!map) return
  map.addSource('cities', {
    type: 'geojson',
    data: fc(CITIES.map((c) => feat({ type: 'Point', coordinates: c.c }, { name: c.name, v: c.v }))),
  })
  map.addLayer({
    id: 'cities',
    type: 'circle',
    source: 'cities',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'v'], 20, 4, 100, 12],
      'circle-color': ['interpolate', ['linear'], ['get', 'v'], 20, '#2b6cb0', 100, '#ffd166'],
      'circle-opacity': 0.9,
    },
  })
}

/** 等地图渲染空闲再执行，保证画面完整 */
function whenIdle(fn: () => void) {
  if (!map) return
  if (map.loaded() && !map.isMoving()) {
    requestAnimationFrame(fn)
    return
  }
  map.once('idle', () => requestAnimationFrame(fn))
}

function snapshot(): string {
  const src = map!.getCanvas()
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  const g = out.getContext('2d')!
  g.drawImage(src, 0, 0)
  if (withLegend.value) {
    // DOM 控件不会被截进去，图例得自己画
    const dpr = src.width / src.clientWidth
    g.scale(dpr, dpr)
    const w = src.clientWidth
    const h = src.clientHeight
    g.fillStyle = 'rgba(12,18,26,0.82)'
    g.fillRect(16, h - 96, 250, 80)
    g.fillStyle = '#eaf2fb'
    g.font = 'bold 14px sans-serif'
    g.fillText('城市指标分布', 30, h - 70)
    g.font = '11px sans-serif'
    g.fillStyle = '#9fb4c9'
    g.fillText(`中心 ${map!.getCenter().lng.toFixed(2)}, ${map!.getCenter().lat.toFixed(2)} · z${map!.getZoom().toFixed(1)}`, 30, h - 52)
    const stops = ['#2b6cb0', '#4f9dff', '#ffd166']
    stops.forEach((c, i) => {
      g.fillStyle = c
      g.fillRect(30 + i * 54, h - 38, 46, 8)
    })
    g.fillStyle = '#9fb4c9'
    g.fillText('低', 30, h - 24)
    g.fillText('高', 30 + 108, h - 24)
    g.fillText('© Esri · OpenStreetMap', w - 190, h - 24)
    g.setTransform(1, 0, 0, 1, 0, 0)
  }
  return out.toDataURL('image/png')
}

function capture() {
  if (!map) return
  note.value = '渲染中…'
  whenIdle(() => {
    preview.value = snapshot()
    note.value = `${map!.getCanvas().width} × ${map!.getCanvas().height}（含 devicePixelRatio）`
  })
}

function download() {
  if (!preview.value) return
  const a = document.createElement('a')
  a.href = preview.value
  a.download = `mapbox-export-${Date.now()}.png`
  a.click()
}

onMounted(() => {
  // 关键：preserveDrawingBuffer 为 false 时导出的图会是全黑/全白
  map = createMap(container.value!, { ...HOME, preserveDrawingBuffer: true })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
  map!.once('idle', capture)
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
      <h4>导出图片</h4>
      <label class="mb-row">
        <input v-model="withLegend" type="checkbox" />
        <span>叠加标题与图例</span>
      </label>
      <div class="btns">
        <button class="mb-btn" @click="capture">截取当前视图</button>
        <button class="mb-btn" :disabled="!preview" @click="download">下载 PNG</button>
      </div>
      <div class="stat">{{ note }}</div>
    </div>
    <div v-if="preview" class="mb-panel shot">
      <h4>预览</h4>
      <img :src="preview" alt="导出预览" />
    </div>
    <div class="mb-tip">preserveDrawingBuffer: true 才能随时读到 canvas 内容</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 226px;
}
.btns {
  display: flex;
  gap: 6px;
  margin: 7px 0;
}
.stat {
  color: #8fa4b9;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.shot {
  right: 60px;
  top: 14px;
  width: 240px;
}
.shot img {
  display: block;
  width: 100%;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
}
</style>
