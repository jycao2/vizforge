<script setup lang="ts">
/**
 * 视频叠加（Video Overlay）
 * ===========================================================================
 * `type: 'video'` 的 source 和 image 一样靠四角 coordinates 定位，
 * 区别是内容逐帧刷新 —— 适合无人机航拍回放、监控画面、历史影像对比。
 *
 * 几个必须注意的点：
 *  - 视频必须 **同源或带 CORS 头** 才能当纹理，否则 WebGL 会拒绝上传
 *    （控制台报 "Tainted canvases may not be loaded"），本例用公开静态资源；
 *  - 移动端/部分浏览器不允许自动播放有声视频，必须 `muted + playsInline`；
 *  - `getVideo()` 拿到内部 <video> 元素，播放/暂停/跳帧都用它控制；
 *  - 视频尺寸不一定要正方形，Mapbox 会按四角做透视拉伸。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap, VideoSource } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const playing = ref(true)
const progress = ref(0)
const duration = ref(0)
const opacity = ref(1)
const status = ref('加载中…')
let map: MbMap | null = null
let raf = 0

const HOME = { center: [120.151, 30.253] as [number, number], zoom: 14.6, pitch: 45 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** Mapbox 官方示例用的公开航拍视频（静态资源，非 mapbox:// 协议，免 Token） */
const VIDEO = 'https://static-assets.mapbox.com/mapbox-gl-js/drone.mp4'

/** 覆盖范围：左上 → 右上 → 右下 → 左下 */
const COORDS: [[number, number], [number, number], [number, number], [number, number]] = [
  [120.1345, 30.2625],
  [120.1675, 30.2625],
  [120.1675, 30.2435],
  [120.1345, 30.2435],
]

function build() {
  if (!map) return
  map.addSource('drone', {
    type: 'video',
    urls: [VIDEO],
    coordinates: COORDS,
  })
  map.addLayer({
    id: 'drone',
    type: 'raster',
    source: 'drone',
    paint: { 'raster-opacity': opacity.value, 'raster-fade-duration': 0 },
  })
  // 边框：标出视频覆盖范围
  map.addSource('frame', {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [...COORDS, COORDS[0]] },
    },
  })
  map.addLayer({
    id: 'frame',
    type: 'line',
    source: 'frame',
    paint: { 'line-color': '#4f9dff', 'line-width': 2, 'line-dasharray': [3, 2] },
  })

  // video 元素由 source 延后创建，getVideo() 可能暂时为 undefined —— 轮询直到拿到
  let tries = 0
  const wire = () => {
    const video = (map?.getSource('drone') as VideoSource | undefined)?.getVideo()
    if (!video) {
      if (++tries < 100) setTimeout(wire, 100)
      else status.value = '视频源加载失败'
      return
    }
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.play().catch(() => {
      status.value = '浏览器阻止了自动播放，点「播放」手动启动'
    })
    video.addEventListener('loadedmetadata', () => {
      duration.value = video.duration || 0
      status.value = `视频就绪 · ${video.videoWidth}×${video.videoHeight}`
    })
  }
  wire()

  // 进度条：直接读 video.currentTime，不需要额外计时器
  const tick = () => {
    raf = requestAnimationFrame(tick)
    const v = (map?.getSource('drone') as VideoSource | undefined)?.getVideo()
    if (v?.duration) progress.value = v.currentTime / v.duration
  }
  tick()
}

function togglePlay() {
  const v = (map?.getSource('drone') as VideoSource | undefined)?.getVideo()
  if (!v) return
  if (v.paused) {
    v.play()
    playing.value = true
  } else {
    v.pause()
    playing.value = false
  }
}

function seek(ev: Event) {
  const v = (map?.getSource('drone') as VideoSource | undefined)?.getVideo()
  const t = Number((ev.target as HTMLInputElement).value)
  if (v && v.duration) v.currentTime = (t / 100) * v.duration
}

function setOpacity(v: number) {
  opacity.value = v
  map?.setPaintProperty('drone', 'raster-opacity', v)
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
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
      <h4>视频叠加</h4>
      <div class="btns">
        <button class="mb-btn" :class="{ on: playing }" @click="togglePlay">
          {{ playing ? '暂停' : '播放' }}
        </button>
        <b class="time">{{ (progress * (duration || 0)).toFixed(1) }}s / {{ duration.toFixed(1) }}s</b>
      </div>
      <input
        class="seek"
        type="range"
        min="0"
        max="100"
        :value="Math.round(progress * 100)"
        @input="seek"
      />
      <label class="mb-row">
        <span>不透明</span>
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
      <div class="hint">{{ status }}</div>
    </div>
    <div class="mb-tip">type: 'video' source · 四角定位 + 逐帧更新纹理</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 236px;
}
.btns {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.time {
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.seek {
  width: 100%;
  accent-color: #4f9dff;
  margin-bottom: 6px;
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
  width: 32px;
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
