<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const pointCount = ref(0)
const lengthText = ref('0 m')
const areaText = ref('—')
const tip = ref('左键添加节点，右键结束量算')

let viewer: Cesium.Viewer | null = null
let handler: Cesium.ScreenSpaceEventHandler | null = null
let points: Cesium.Cartesian3[] = []
let cursor: Cesium.Cartesian3 | null = null
let dynamicLine: Cesium.Entity | null = null
let shapeEntities: Cesium.Entity[] = []

const home = {
  destination: Cesium.Cartesian3.fromDegrees(116.391, 39.82, 9000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-45),
    roll: 0,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer)

/** 椭球大地线长度 */
function pathLength(pts: Cesium.Cartesian3[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const a = Cesium.Cartographic.fromCartesian(pts[i - 1])
    const b = Cesium.Cartographic.fromCartesian(pts[i])
    total += new Cesium.EllipsoidGeodesic(a, b).surfaceDistance
  }
  return total
}

/** 面积：投影到以中心纬度为基准的局部平面后做鞋带公式（近似值） */
function polygonArea(pts: Cesium.Cartesian3[]): number {
  if (pts.length < 3) return 0
  const R = Cesium.Ellipsoid.WGS84.maximumRadius
  const carto = pts.map((p) => Cesium.Cartographic.fromCartesian(p))
  const lat0 = carto.reduce((s, c) => s + c.latitude, 0) / carto.length
  const cos = Math.cos(lat0)
  const xy = carto.map((c) => [c.longitude * cos * R, c.latitude * R])
  let sum = 0
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i]
    const [x2, y2] = xy[(i + 1) % xy.length]
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum / 2)
}

function formatLength(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`
}
function formatArea(m2: number) {
  if (m2 === 0) return '—'
  return m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : `${m2.toFixed(0)} m²`
}

function pickGround(pos: Cesium.Cartesian2): Cesium.Cartesian3 | null {
  if (!viewer) return null
  return viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid) ?? null
}

function refreshLive() {
  const pts = cursor && points.length ? [...points, cursor] : points
  lengthText.value = formatLength(pathLength(pts))
  if (pts.length >= 3) {
    const closed = [...pts, pts[0]]
    areaText.value = formatArea(polygonArea(pts))
    void closed
  } else {
    areaText.value = '—'
  }
  pointCount.value = points.length
}

function ensureDynamicLine() {
  if (dynamicLine || !viewer) return
  dynamicLine = viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const live = cursor && points.length ? [...points, cursor] : points
        return live.length >= 2 ? live : []
      }, false),
      width: 3,
      material: Cesium.Color.CYAN.withAlpha(0.9),
    },
  })
}

function removeShapeEntities() {
  if (!viewer) return
  for (const e of shapeEntities) viewer.entities.remove(e)
  shapeEntities = []
}

function finish() {
  if (!viewer || points.length < 2) {
    tip.value = '至少需要 2 个节点'
    return
  }
  const pts = points.slice()
  const length = pathLength(pts)
  const area = pts.length >= 3 ? polygonArea(pts) : 0

  shapeEntities.push(
    viewer.entities.add({
      polyline: {
        positions: [...pts, pts[0]],
        width: 6,
        material: Cesium.Color.YELLOW.withAlpha(0.85),
        clampToGround: false,
      },
    }),
  )

  if (pts.length >= 3) {
    shapeEntities.push(
      viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(pts),
          material: Cesium.Color.YELLOW.withAlpha(0.22),
          outline: true,
          outlineColor: Cesium.Color.YELLOW,
        },
      }),
    )
  }

  shapeEntities.push(
    viewer.entities.add({
      position: pts[pts.length - 1],
      label: {
        text: `长度 ${formatLength(length)}${area ? `\n面积 ${formatArea(area)}` : ''}`,
        font: '12px sans-serif',
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#111822').withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -18),
        fillColor: Cesium.Color.WHITE,
      },
    }),
  )

  tip.value = `量算完成：长度 ${formatLength(length)}${area ? `，面积 ${formatArea(area)}` : ''}`
  points = []
  cursor = null
  pointCount.value = 0
  if (dynamicLine) {
    viewer.entities.remove(dynamicLine)
    dynamicLine = null
  }
  lengthText.value = '0 m'
  areaText.value = '—'
}

function clearAll() {
  if (!viewer) return
  removeShapeEntities()
  points = []
  cursor = null
  pointCount.value = 0
  lengthText.value = '0 m'
  areaText.value = '—'
  tip.value = '左键添加节点，右键结束量算'
  if (dynamicLine) {
    viewer.entities.remove(dynamicLine)
    dynamicLine = null
  }
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.camera.setView(home)
  ensureDynamicLine()

  handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

  handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (!viewer) return
    const p = pickGround(m.position)
    if (!p) return
    points.push(p)
    shapeEntities.push(
      viewer.entities.add({
        position: p,
        point: {
          pixelSize: 8,
          color: Cesium.Color.ORANGE,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
      }),
    )
    ensureDynamicLine()
    refreshLive()
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    cursor = pickGround(m.endPosition)
    refreshLive()
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

  handler.setInputAction(() => finish(), Cesium.ScreenSpaceEventType.RIGHT_CLICK)
})

onBeforeUnmount(() => {
  handler?.destroy()
  handler = null
  viewer?.destroy()
  viewer = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>
    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="panel">
      <div class="tip">{{ tip }}</div>
      <div class="stats">
        <span>节点 <b>{{ pointCount }}</b></span>
        <span>长度 <b>{{ lengthText }}</b></span>
        <span>面积 <b>{{ areaText }}</b></span>
      </div>
      <div class="row">
        <button class="btn" @click="finish">结束并标绘</button>
        <button class="btn" @click="clearAll">清除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.cesium-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 300px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.tip {
  font-size: 12px;
  color: #9fb0c2;
  line-height: 1.5;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 0;
  font-size: 12px;
  color: #8b9aab;
}
.stats b {
  color: #7ee787;
  font-weight: 600;
}
.row {
  display: flex;
  gap: 8px;
}
.btn {
  flex: 1;
  padding: 6px 0;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: transparent;
  color: #c3cfdb;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
</style>
