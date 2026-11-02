<script setup lang="ts">
/**
 * 图片叠加（Image Overlay）
 * ===========================================================================
 * 把一张普通图片"钉"在地理范围内：规划图、历史影像、雷达回波、无人机正射影像都靠它。
 * Mapbox 的做法是 raster source + `coordinates`（四角经纬度，顺序必须是
 * **左上 → 右上 → 右下 → 左下**，Mapbox 会做双线性拉伸贴合）。
 *
 * 本例的图片用 canvas 现画（一张"地块规划图"），好处是不依赖外部资源，
 * 而且能顺手演示：图片是任意分辨率都行的 —— 贴图会按四角做透视纠正。
 *
 * 旋转的实现：绕中心旋转四个角点。注意经纬度空间不是各向同性的，
 * 经度 1° 的实际米数 = 纬度 1° × cos(lat)，所以旋转时要先把经度差除以 cos(lat)
 * 转到"米空间"再转回来，否则图会被拉扁。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap, GeoJSONSource, ImageSource } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { fc, feat, mulberry32 } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const opacity = ref(0.85)
const angle = ref(0)
let map: MbMap | null = null

const HOME = { center: [120.152, 30.253] as [number, number], zoom: 14 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 图片覆盖范围（未旋转时的四角：左上 / 右上 / 右下 / 左下） */
const BASE: Array<[number, number]> = [
  [120.138, 30.262],
  [120.168, 30.262],
  [120.168, 30.244],
  [120.138, 30.244],
]

/** 画一张规划图：地块色块 + 路网 + 指北针 + 图框 */
function drawPlan(): string {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const g = c.getContext('2d')!
  const rnd = mulberry32(42)

  g.fillStyle = '#0f1c2b'
  g.fillRect(0, 0, 512, 512)
  // 地块
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const x = 30 + i * 76
      const y = 30 + j * 76
      const t = rnd()
      g.fillStyle =
        t < 0.4 ? 'rgba(47,158,95,0.55)' : t < 0.75 ? 'rgba(79,157,255,0.45)' : 'rgba(255,209,102,0.4)'
      g.fillRect(x, y, 62, 62)
      g.strokeStyle = 'rgba(220,235,250,0.35)'
      g.lineWidth = 1
      g.strokeRect(x, y, 62, 62)
    }
  }
  // 主干道
  g.strokeStyle = 'rgba(255,255,255,0.65)'
  g.lineWidth = 9
  g.beginPath()
  g.moveTo(20, 256)
  g.lineTo(492, 256)
  g.moveTo(256, 20)
  g.lineTo(256, 492)
  g.stroke()
  // 指北针
  g.fillStyle = '#ffd166'
  g.beginPath()
  g.moveTo(470, 52)
  g.lineTo(458, 78)
  g.lineTo(482, 78)
  g.closePath()
  g.fill()
  // 图框与标题
  g.strokeStyle = 'rgba(120,200,255,0.8)'
  g.lineWidth = 3
  g.strokeRect(6, 6, 500, 500)
  g.fillStyle = 'rgba(200,230,255,0.9)'
  g.font = 'bold 22px sans-serif'
  g.fillText('DEMO 地块规划图', 22, 40)
  g.font = '14px sans-serif'
  g.fillStyle = 'rgba(160,190,220,0.9)'
  g.fillText('512 × 512 px · 程序化生成', 22, 500 - 22)
  return c.toDataURL('image/png')
}

type Quad = [[number, number], [number, number], [number, number], [number, number]]

function corners(deg: number): Quad {
  const cx = (BASE[0][0] + BASE[2][0]) / 2
  const cy = (BASE[0][1] + BASE[2][1]) / 2
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const k = Math.cos((cy * Math.PI) / 180) // 经度方向的米数压缩系数
  const out = BASE.map(([lon, lat]) => {
    // 先转到以中心为原点的"米空间"，旋转后再转回经纬度
    const x = (lon - cx) / k
    const y = lat - cy
    return [cx + (x * cos - y * sin) * k, cy + (x * sin + y * cos)] as [number, number]
  })
  return [out[0], out[1], out[2], out[3]] as Quad
}

function build() {
  if (!map) return
  map.addSource('img', {
    type: 'image',
    url: drawPlan(),
    coordinates: corners(0),
  })
  map.addLayer({
    id: 'img',
    type: 'raster',
    source: 'img',
    paint: { 'raster-opacity': opacity.value, 'raster-fade-duration': 0 },
  })

  // 角点标记：直观看出图片被钉在哪
  map.addSource('corners', { type: 'geojson', data: fc([]) })
  map.addLayer({
    id: 'corners',
    type: 'circle',
    source: 'corners',
    paint: {
      'circle-radius': 5,
      'circle-color': '#ffd166',
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(8,14,22,0.9)',
    },
  })
  syncCorners()
}

function syncCorners() {
  if (!map) return
  const c = corners(angle.value)
  ;(map.getSource('img') as ImageSource).setCoordinates(c)
  ;(map.getSource('corners') as GeoJSONSource).setData(
    fc(c.map((p) => feat({ type: 'Point', coordinates: p }))),
  )
}

function setOpacity(v: number) {
  opacity.value = v
  map?.setPaintProperty('img', 'raster-opacity', v)
}

function setAngle(v: number) {
  angle.value = v
  syncCorners()
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
      <h4>图片叠加</h4>
      <label class="mb-row">
        <span>透明度</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="opacity"
          @input="setOpacity(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ opacity.toFixed(2) }}</b>
      </label>
      <label class="mb-row">
        <span>旋转角</span>
        <input
          type="range"
          min="-180"
          max="180"
          step="1"
          :value="angle"
          @input="setAngle(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ angle }}°</b>
      </label>
      <div class="hint">四角顺序：左上 → 右上 → 右下 → 左下</div>
    </div>
    <div class="mb-tip">旋转在"米空间"里做，避免经纬度各向异性把图拉扁</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 236px;
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
  width: 38px;
  text-align: right;
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
}
</style>
