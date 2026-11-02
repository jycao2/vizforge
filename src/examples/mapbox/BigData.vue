<script setup lang="ts">
/**
 * 十万点性能
 * ===========================================================================
 * 大数量点直接"每点一个 DOM 标记"必死，Mapbox 的正确姿势是：
 *
 *  - 数据只传一次给 GeoJSON source，之后所有渲染都在 worker + GPU 上做；
 *  - 点样式用 circle 图层（GPU 实例化），不要 symbol（文字要做碰撞检测，贵得多）；
 *  - 需要"看密度"时切 heatmap —— 同样是 GPU 聚合；
 *  - **不要**在大图层上开 feature-state 或 generateId（会增加索引开销）；
 *  - 过滤用 setFilter（worker 端索引），不要每次 setData 重传十万条。
 *
 * 本例把耗时拆成三段测出来：数据生成（主线程）/ source 入库（含 worker 索引）/
 * 首帧渲染完成（idle 事件），再持续统计 FPS，方便直观对比"换渲染方式"的代价。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap, GeoJSONSource } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { gaussian, mulberry32 } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const mode = ref<'circle' | 'heatmap' | 'none'>('circle')
const count = ref(100000)
const perf = ref('')
const fps = ref(0)
let map: MbMap | null = null
let frames = 0
let last = 0

const HOME = { center: [114, 32] as [number, number], zoom: 3.6 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/**
 * 直接拼 FeatureCollection 的对象字面量而不是走 Feature 类 —— 十万条时
 * 省掉的构造函数开销很可观。坐标写进普通数组即可，Mapbox 序列化时再转。
 */
function gen(n: number): { data: GeoJSON.FeatureCollection; ms: number } {
  const t0 = performance.now()
  const rnd = mulberry32(2026)
  const centers = [
    [116.39, 39.91],
    [121.47, 31.23],
    [113.26, 23.13],
    [120.15, 30.27],
    [104.07, 30.57],
    [108.94, 34.34],
  ]
  const features: GeoJSON.Feature[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const c = centers[i % centers.length]
    features[i] = {
      type: 'Feature',
      properties: { v: 1 + Math.floor(rnd() * 100) },
      geometry: {
        type: 'Point',
        coordinates: [c[0] + gaussian(rnd) * 1.9, c[1] + gaussian(rnd) * 1.4],
      },
    }
  }
  return { data: { type: 'FeatureCollection', features }, ms: performance.now() - t0 }
}

function build() {
  if (!map) return
  const g = gen(count.value)
  const t1 = performance.now()
  map.addSource('big', { type: 'geojson', data: g.data })
  const t2 = performance.now()

  map.addLayer({
    id: 'big-circle',
    type: 'circle',
    source: 'big',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 0.7, 10, 3.4],
      'circle-color': ['interpolate', ['linear'], ['get', 'v'], 1, '#2b6cb0', 100, '#ffd166'],
      'circle-opacity': 0.6,
      // 密集处叠出亮斑：关掉描边能再省一笔
      'circle-stroke-width': 0,
    },
  })
  map.addLayer({
    id: 'big-heat',
    type: 'heatmap',
    source: 'big',
    layout: { visibility: 'none' },
    paint: {
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 8, 10, 34],
      'heatmap-opacity': 0.9,
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0,
        'rgba(0,0,0,0)',
        0.3,
        '#2b7fb8',
        0.65,
        '#ffd166',
        1,
        '#ff4d4d',
      ],
    },
  })

  map.once('idle', () => {
    const t3 = performance.now()
    perf.value =
      `生成 ${g.ms.toFixed(0)}ms · 入库 ${(t2 - t1).toFixed(0)}ms · ` +
      `首帧 ${(t3 - t2).toFixed(0)}ms · 共 ${count.value.toLocaleString()} 点`
  })

  // FPS：render 事件计数
  map.on('render', () => {
    frames++
    const now = performance.now()
    if (now - last >= 1000) {
      fps.value = Math.round((frames * 1000) / (now - last))
      frames = 0
      last = now
    }
  })
  last = performance.now()
}

function setMode(m: 'circle' | 'heatmap' | 'none') {
  mode.value = m
  if (!map) return
  const vis = (id: string, v: boolean) => {
    if (map!.getLayer(id)) map!.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none')
  }
  vis('big-circle', m === 'circle')
  vis('big-heat', m === 'heatmap')
}

/** 换数据量：清掉旧 source 重建，顺便看看十万点入库要多久 */
function reload() {
  if (!map) return
  if (map.getLayer('big-circle')) map.removeLayer('big-circle')
  if (map.getLayer('big-heat')) map.removeLayer('big-heat')
  if (map.getSource('big')) map.removeSource('big')
  perf.value = '重新生成中…'
  const g = gen(count.value)
  const t1 = performance.now()
  map.addSource('big', { type: 'geojson', data: g.data })
  const t2 = performance.now()
  // 图层重建后要按当前模式恢复显隐
  buildLayers()
  map.once('idle', () => {
    perf.value =
      `生成 ${g.ms.toFixed(0)}ms · 入库 ${(t2 - t1).toFixed(0)}ms · 共 ${count.value.toLocaleString()} 点`
  })
  setMode(mode.value)
}

function buildLayers() {
  if (!map) return
  if (!map.getLayer('big-circle')) {
    map.addLayer({
      id: 'big-circle',
      type: 'circle',
      source: 'big',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 0.7, 10, 3.4],
        'circle-color': ['interpolate', ['linear'], ['get', 'v'], 1, '#2b6cb0', 100, '#ffd166'],
        'circle-opacity': 0.6,
        'circle-stroke-width': 0,
      },
    })
  }
  if (!map.getLayer('big-heat')) {
    map.addLayer({
      id: 'big-heat',
      type: 'heatmap',
      source: 'big',
      layout: { visibility: 'none' },
      paint: {
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 8, 10, 34],
        'heatmap-opacity': 0.9,
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0,
          'rgba(0,0,0,0)',
          0.3,
          '#2b7fb8',
          0.65,
          '#ffd166',
          1,
          '#ff4d4d',
        ],
      },
    })
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

// 供模板使用
const counts = [20000, 50000, 100000, 200000]
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
      <h4>大数据量</h4>
      <div class="btns">
        <button class="mb-btn" :class="{ on: mode === 'circle' }" @click="setMode('circle')">散点</button>
        <button class="mb-btn" :class="{ on: mode === 'heatmap' }" @click="setMode('heatmap')">热力</button>
        <button class="mb-btn" :class="{ on: mode === 'none' }" @click="setMode('none')">关闭</button>
      </div>
      <label class="mb-row">
        <span>点数</span>
        <select v-model.number="count" class="sel" @change="reload">
          <option v-for="c in counts" :key="c" :value="c">{{ c.toLocaleString() }}</option>
        </select>
      </label>
      <div class="stat">{{ perf || '加载中…' }}</div>
      <div class="stat">FPS {{ fps }}</div>
    </div>
    <div class="mb-tip">GPU 实例化渲染 · 过滤请走 setFilter，不要反复 setData</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 232px;
}
.btns {
  display: flex;
  gap: 6px;
  margin-bottom: 7px;
}
.sel {
  flex: 1;
  padding: 3px 6px;
  border-radius: 6px;
  background: rgba(8, 14, 22, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #eaf2fb;
  font-size: 11.5px;
}
.mb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
}
.stat {
  margin-top: 5px;
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}
</style>
