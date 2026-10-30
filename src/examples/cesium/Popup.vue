<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null
let handler: Cesium.ScreenSpaceEventHandler | null = null
let removePostRender: (() => void) | null = null

const home = {
  destination: Cesium.Cartesian3.fromDegrees(113, 33, 6200000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-75), roll: 0 },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer)

interface Info {
  name: string
  lon: number
  lat: number
  desc: string
}

const CITIES: Info[] = [
  { name: '北京', lon: 116.391, lat: 39.907, desc: '首都 · 政治文化中心' },
  { name: '上海', lon: 121.474, lat: 31.23, desc: '国际金融与航运中心' },
  { name: '广州', lon: 113.264, lat: 23.129, desc: '粤港澳大湾区核心城市' },
  { name: '成都', lon: 104.066, lat: 30.572, desc: '西部中心城市' },
  { name: '西安', lon: 108.948, lat: 34.263, desc: '十三朝古都' },
  { name: '哈尔滨', lon: 126.535, lat: 45.803, desc: '东北亚冰雪之城' },
]

/** 当前选中的城市与它的屏幕坐标 */
const active = ref<Info | null>(null)
const screenX = ref(0)
const screenY = ref(0)
let activeCartesian: Cesium.Cartesian3 | null = null

function closePopup() {
  active.value = null
  activeCartesian = null
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.scene.globe.enableLighting = false
  viewer.camera.setView(home)

  for (const c of CITIES) {
    const entity = viewer.entities.add({
      id: `city-${c.name}`,
      position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 0),
      properties: { info: c },
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString('#4f9dff'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: c.name,
        font: '12px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -20),
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      },
    })
    void entity
  }

  // 点击拾取实体 → 打开信息卡
  handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const v = viewer
    if (!v) return
    const picked = v.scene.pick(click.position)
    const entity = picked?.id as Cesium.Entity | undefined
    const info = entity?.properties?.info?.getValue(Cesium.JulianDate.now()) as Info | undefined
    if (!entity || !info) {
      closePopup()
      return
    }
    active.value = info
    activeCartesian = entity.position?.getValue(v.clock.currentTime) ?? null
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  // 每帧把世界坐标投影成屏幕坐标，弹窗跟随地图旋转缩放
  const onPostRender = () => {
    if (!activeCartesian || !viewer) return
    const pos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, activeCartesian)
    if (pos) {
      screenX.value = pos.x
      screenY.value = pos.y
    }
  }
  viewer.scene.postRender.addEventListener(onPostRender)
  removePostRender = () => viewer?.scene.postRender.removeEventListener(onPostRender)
})

onBeforeUnmount(() => {
  handler?.destroy()
  handler = null
  removePostRender?.()
  removePostRender = null
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

    <div
      v-if="active"
      class="popup"
      :style="{ left: screenX + 'px', top: screenY + 'px' }"
      @click.stop
    >
      <div class="popup-head">
        <span class="popup-title">{{ active.name }}</span>
        <button class="popup-close" aria-label="关闭" @click="closePopup">×</button>
      </div>
      <div class="popup-body">
        <div class="row"><span>经度</span><b>{{ active.lon.toFixed(3) }}°E</b></div>
        <div class="row"><span>纬度</span><b>{{ active.lat.toFixed(3) }}°N</b></div>
        <div class="row"><span>说明</span><b>{{ active.desc }}</b></div>
      </div>
      <div class="popup-arrow"></div>
    </div>

    <div class="panel">
      <div class="title">点击城市点位查看信息卡</div>
      <div class="hint">
        弹窗不是 Cesium 内置控件：用 scene.pick 取到实体，再在 postRender 里把世界坐标投影为屏幕坐标，DOM 卡片随之跟随。
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

.popup {
  position: absolute;
  z-index: 25;
  transform: translate(-50%, calc(-100% - 18px));
  min-width: 190px;
  padding: 9px 11px 10px;
  border-radius: 9px;
  background: rgba(15, 21, 29, 0.95);
  border: 1px solid rgba(79, 157, 255, 0.55);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(10px);
  cursor: default;
}
.popup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.popup-title {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}
.popup-close {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #8b9aab;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.popup-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.popup-body {
  margin-top: 7px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  font-size: 11.5px;
  color: #7f8d9d;
}
.row b {
  color: #d6e2ef;
  font-weight: 500;
}
.popup-arrow {
  position: absolute;
  left: 50%;
  bottom: -6px;
  width: 10px;
  height: 10px;
  transform: translateX(-50%) rotate(45deg);
  background: rgba(15, 21, 29, 0.95);
  border-right: 1px solid rgba(79, 157, 255, 0.55);
  border-bottom: 1px solid rgba(79, 157, 255, 0.55);
}

.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 340px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e6eef7;
}
.hint {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.55;
  color: #8b9aab;
}
</style>
