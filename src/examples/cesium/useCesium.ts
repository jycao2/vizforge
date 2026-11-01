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

/* ============================================================
 * 全球三维地形
 *
 * 不开地形的话 Cesium 的地球就是一个光滑椭球，任何 demo 都像「贴在
 * 一张平纸上的贴图」，看不出体积。这里用 Esri World Elevation：
 * 免 Token、响应头带 CORS，和 basemaps.ts 里的影像同源同策略。
 *
 * 开了地形之后自定义高程 (* DEM 三角网 / 水面 / 设计面) 必须抬高到
 * 真实地面之上，否则会埋进山体或悬空 —— 用 sampleGroundHeight 取偏移。
 * ============================================================ */
export const WORLD_TERRAIN_URL =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

/**
 * 异步挂上 Esri 全球地形。加载失败（离线）时静默退回光滑椭球，不影响其它功能。
 * @returns 取消函数，组件卸载前调用
 */
export function enableWorldTerrain(viewer: Viewer): () => void {
  let cancelled = false
  Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(WORLD_TERRAIN_URL)
    .then((tp) => {
      if (cancelled || viewer.isDestroyed()) return
      viewer.terrainProvider = tp
      // 地形瓦片最高只到 L11 附近，默认的屏幕空间误差会让远处山体糊成一片
      viewer.scene.globe.maximumScreenSpaceError = 1.6
    })
    .catch(() => {
      /* 离线：保持椭球 */
    })
  return () => {
    cancelled = true
  }
}

/** 采样某点的真实地面海拔（米），用于给自定义几何做抬升偏移 */
export async function sampleGroundHeight(
  viewer: Viewer,
  lon: number,
  lat: number,
): Promise<number> {
  try {
    const [c] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
      Cesium.Cartographic.fromDegrees(lon, lat),
    ])
    return Number.isFinite(c?.height) ? c.height : 0
  } catch {
    return 0
  }
}

/**
 * 「真实三维场景」一站式开关：全球地形 + 雾 + 地表大气。
 *
 * 只开地形是不够的——dark 底图 + 无雾的场景下，远处山体融进黑背景，
 * 整个画面仍然像一张贴在黑板上的平面图。雾给山体前后景深提示，
 * 地表大气给地球边缘一圈亮边，地平线才「立」得起来。
 * @returns 取消函数，组件卸载前调用
 */
export function enableTerrainScene(viewer: Viewer): () => void {
  const stop = enableWorldTerrain(viewer)
  const scene = viewer.scene
  const prevFog = scene.fog.enabled
  scene.fog.enabled = true
  scene.fog.density = 0.00012
  scene.globe.showGroundAtmosphere = true
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a2b33')
  return () => {
    stop()
    scene.fog.enabled = prevFog
    scene.globe.showGroundAtmosphere = false
  }
}

/**
 * 等真实地形挂载完成（enableWorldTerrain 是异步的，采样海拔前必须先等它就位）。
 * @returns 是否成功（超时/离线返回 false，调用方按 offset=0 兜底）
 */
export async function waitRealTerrain(viewer: Viewer, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !viewer.isDestroyed()) {
    if (viewer.terrainProvider instanceof Cesium.ArcGISTiledElevationTerrainProvider) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * 采样一块矩形内的真实地形高程（n×n，第 0 行是北边）。
 * 用于把分析基底换成真实地面——分析面与地形贴合，缩放时不会"浮起来"。
 * @param level 采样瓦片层级，11~12 对 10km 级场地足够，点数 65² 时约 4k 个、耗时几百毫秒
 * @returns 高程数组；地形未就绪或离线时返回 null（调用方退回程序化地形）
 */
export async function sampleTerrainGrid(
  viewer: Viewer,
  lon0: number,
  lat0: number,
  lon1: number,
  lat1: number,
  n: number,
  level = 12,
): Promise<Float32Array | null> {
  if (!(viewer.terrainProvider instanceof Cesium.ArcGISTiledElevationTerrainProvider)) return null
  const pts: Cesium.Cartographic[] = []
  for (let j = 0; j < n; j++) {
    const lat = lat1 - ((lat1 - lat0) * j) / (n - 1) // 第 0 行 = 北边
    for (let i = 0; i < n; i++) {
      pts.push(Cesium.Cartographic.fromDegrees(lon0 + ((lon1 - lon0) * i) / (n - 1), lat))
    }
  }
  try {
    const res = await Cesium.sampleTerrain(viewer.terrainProvider, level, pts)
    const out = new Float32Array(n * n)
    for (let k = 0; k < out.length; k++) {
      const h = res[k]?.height
      out[k] = Number.isFinite(h) ? (h as number) : 0
    }
    return out
  } catch {
    return null
  }
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
