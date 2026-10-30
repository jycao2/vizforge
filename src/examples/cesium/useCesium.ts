import { ref } from 'vue'
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import { applyCesiumBasemap, DEFAULT_BASEMAP } from './basemaps'

export interface HomeView {
  destination: Cesium.Cartesian3
  orientation?: Cesium.HeadingPitchRollValues
}

/**
 * 以「屏幕中心的地物点」为锚点缩放。
 * 直接用 camera.zoomIn/zoomOut 是沿视线后退，倾斜视角下地球会越缩越偏出画面；
 * 这里保持锚点不动、沿「锚点→相机」方向改变距离，地球始终居中。
 */
export function zoomCesiumCamera(viewer: Viewer, scale: number) {
  const cam = viewer.camera
  const scene = viewer.scene
  const h = cam.positionCartographic.height
  const targetH = Cesium.Math.clamp(h * scale, 8, 2.4e7)

  const ray = new Cesium.Ray(cam.positionWC, cam.directionWC)
  const hit = scene.globe.pick(ray, scene)
  const target =
    hit ??
    Cesium.Cartesian3.fromRadians(
      cam.positionCartographic.longitude,
      cam.positionCartographic.latitude,
      0,
    )

  const dist = Cesium.Cartesian3.distance(cam.positionWC, target)
  // 无遮挡时按高度比例推拉；命中地面时按当前距离比例，避免贴地时跳变
  const next = hit
    ? Cesium.Math.clamp(dist * scale, 6, 2.4e7)
    : Cesium.Math.clamp(targetH, 6, 2.4e7)

  const dir = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(cam.positionWC, target, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  const pos = Cesium.Cartesian3.add(
    target,
    Cesium.Cartesian3.multiplyByScalar(dir, next, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  cam.setView({
    destination: pos,
    orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
  })
}

/** 视图操作：放大 / 缩小 / 复位 / 全屏，供 MapControls 直接绑定 */
export function useCesiumView(getViewer: () => Viewer | null, getHome: () => HomeView) {
  function zoomIn() {
    const v = getViewer()
    if (v) zoomCesiumCamera(v, 1 / 1.6)
  }
  function zoomOut() {
    const v = getViewer()
    if (v) zoomCesiumCamera(v, 1.6)
  }
  function reset() {
    const home = getHome()
    getViewer()?.camera.flyTo({ ...home, duration: 1.2 })
  }
  async function toggleFullscreen(el?: HTMLElement) {
    if (!el) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.requestFullscreen()
  }
  return { zoomIn, zoomOut, reset, toggleFullscreen }
}

/** 底图切换：维护当前底图 id 与图层引用 */
export function useCesiumBasemap(getViewer: () => Viewer | null, initial = DEFAULT_BASEMAP) {
  const current = ref(initial)
  let layer: Cesium.ImageryLayer | null = null

  function apply(id: string) {
    const v = getViewer()
    if (!v) return
    layer = applyCesiumBasemap(v, id, layer)
    current.value = id
  }

  function dispose() {
    layer = null
  }

  return { current, apply, dispose }
}

/** 统一的 Viewer 配置：关闭所有内置控件，交给自定义工具栏 */
export const VIEWER_OPTIONS = {
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
} as const satisfies Cesium.Viewer.ConstructorOptions
