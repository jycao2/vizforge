import { onBeforeUnmount, ref } from 'vue'
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import { applyCesiumBasemap, DEFAULT_BASEMAP } from './basemaps'
import { provideMapHost } from '@/components/mapHost'

export interface HomeView {
  destination: Cesium.Cartesian3
  orientation?: Cesium.HeadingPitchRollValues
  /**
   * 内容包围球：给了它，复位与缩放都以「内容」为锚点，而不是以屏幕中心射线为准。
   * 手写 destination 只能保证「相机在哪」，保证不了「内容在画面中间」——
   * 场景一多，总有几个偏到边角，缩放两下更是直接推出去。
   */
  focus?: {
    center: Cesium.Cartesian3
    radius: number
    /** 复位时的相机距离，缺省 radius * 2.6 */
    range?: number
  }
}

/**
 * 以焦点为中心算相机位姿。
 *
 * 不用 flyToBoundingSphere：它的 range 语义（距球心 / 距球面）与手写 destination 对不上，
 * 而且焦点取地心时 ENU 坐标系会退化。这里直接用「ENU 视线方向反推相机位置」，可控且可解释。
 */
function focusPose(home: HomeView, range: number) {
  const f = home.focus!
  const heading = home.orientation?.heading ?? 0
  const pitch = home.orientation?.pitch ?? Cesium.Math.toRadians(-35)
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(f.center)
  const local = new Cesium.Cartesian3(
    Math.cos(pitch) * Math.sin(heading),
    Math.cos(pitch) * Math.cos(heading),
    Math.sin(pitch),
  )
  const view = Cesium.Matrix4.multiplyByPointAsVector(enu, local, new Cesium.Cartesian3())
  const dest = Cesium.Cartesian3.subtract(
    f.center,
    Cesium.Cartesian3.multiplyByScalar(view, range, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  return { destination: dest, orientation: { heading, pitch, roll: 0 } }
}

/** 以内容为锚点取景（内容必然居中） */
function viewFocus(viewer: Viewer, home: HomeView, range: number, duration: number) {
  if (!home.focus) return false
  // 页面可能在 onMounted 里起了飞行动画，不掐掉它会在 focus 之后把相机再拽走
  viewer.camera.cancelFlight()
  const pose = focusPose(home, range)
  if (duration > 0) viewer.camera.flyTo({ ...pose, duration })
  else viewer.camera.setView(pose)
  return true
}

/**
 * 以「屏幕中心的地物点」为锚点缩放。
 * 直接用 camera.zoomIn/zoomOut 是沿视线后退，倾斜视角下地球会越缩越偏出画面；
 * 这里保持锚点不动、沿「锚点→相机」方向改变距离，地球始终居中。
 *
 * 注意两个会「缩一下就没」的坑：
 *  1. globe.pick 在瓦片没加载完时返回 undefined，此时若拿「相机正下方地面」当锚点，
 *     视线中心与锚点根本不是同一个点，一缩放内容就整体滑出画面 —— 宁可不动；
 *  2. 距离不设上下限，缩到底就是贴地/钻地，放到底地球只剩一个点。
 */
export function zoomCesiumCamera(viewer: Viewer, scale: number, smooth = true) {
  const cam = viewer.camera
  const scene = viewer.scene
  const canvas = scene.canvas
  const ray = new Cesium.Ray(cam.positionWC, cam.directionWC)

  // 依次尝试：视线与地形求交 → 视线与椭球求交；都失败（看向天空）就不动
  const target =
    scene.globe.pick(ray, scene) ??
    cam.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      scene.globe.ellipsoid,
    )
  if (!target) return

  const dist = Cesium.Cartesian3.distance(cam.positionWC, target)
  const next = Cesium.Math.clamp(dist * scale, 25, 2e7)

  const dir = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(cam.positionWC, target, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  const pos = Cesium.Cartesian3.add(
    target,
    Cesium.Cartesian3.multiplyByScalar(dir, next, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  const view = {
    destination: pos,
    orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
  }
  // 滚轮是连续事件，用 flyTo 会一路排队；按钮点击才需要补间
  if (smooth) cam.flyTo({ ...view, duration: 0.45 })
  else cam.setView(view)
}

/** 视图操作：放大 / 缩小 / 复位 / 全屏，供 MapControls 直接绑定 */
export function useCesiumView(getViewer: () => Viewer | null, getHome: () => HomeView) {
  // 把 viewer 暴露给工具栏（测距/测面/测高），页面无需额外传参
  provideMapHost(() => {
    const v = getViewer()
    return v ? { kind: 'cesium', instance: v } : null
  })

  // 仅开发期：给巡检脚本一个取景评估入口（生产构建里会被摇掉）
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__vzViewer = getViewer
  }

  /** 页面的 home 可能依赖还没算出来的数据（如排污口坐标、tileset 包围球），取不到就当没有 */
  function safeHome(): HomeView | null {
    try {
      return getHome()
    } catch {
      return null
    }
  }

  /** 有 focus 时围绕内容缩放：range 相对当前距离，并夹在 [1.3r, 9r] */
  function zoomBy(ratio: number, smooth = true) {
    const v = getViewer()
    if (!v) return
    const home = safeHome()
    if (!home) return
    if (home.focus) {
      const { center, radius, range } = home.focus
      const dist = Cesium.Cartesian3.distance(v.camera.positionWC, center)
      const next = Cesium.Math.clamp(
        dist * ratio,
        // 下限别贴着包围球：再往里就是穿模和满屏马赛克
        Math.max(radius * 1.3, 30),
        radius * 9,
      )
      if (range !== undefined && dist > range * 6) {
        // 相机被拖得太远时，向 home 距离收敛，避免一次次缩放都在"太空"里
        viewFocus(v, home, Math.max(range, radius * 1.6), smooth ? 0.5 : 0)
        return
      }
      viewFocus(v, home, next, smooth ? 0.5 : 0)
      return
    }
    zoomCesiumCamera(v, ratio, smooth)
  }

  const zoomIn = () => zoomBy(1 / 1.6)
  const zoomOut = () => zoomBy(1.6)

  function reset() {
    const v = getViewer()
    if (!v) return
    const home = safeHome()
    if (!home) return
    const f = home.focus
    if (f) {
      viewFocus(v, home, f.range ?? f.radius * 2.6, 1.1)
      return
    }
    v.camera.flyTo({ ...home, duration: 1.2 })
  }

  /* ---------------- 滚轮缩放：接管掉 Cesium 的默认实现 ---------------- */
  /**
   * Cesium 的默认滚轮缩放是「沿视线方向后退」（camera.zoomOut → moveBackward）。
   * 视线只是一条擦过球面的直线，相机沿它越退越远，球心与视线的夹角就越大 ——
   * 倾斜视角下滚几下，地球整颗飘出画面。这里换成和按钮相同的锚点缩放：
   * 锚点（屏幕中心命中的地面点）在屏幕上不动，只改「锚点→相机」的距离。
   */
  let attached: Viewer | null = null

  const onWheel = (e: WheelEvent) => {
    if (!attached || attached.isDestroyed()) return
    e.preventDefault()
    // 触控板一次能发几百的 deltaY，夹一下免得一下跳到底
    const k = e.deltaMode === 1 ? 0.05 : 0.0015
    const ratio = Math.exp(Cesium.Math.clamp(e.deltaY, -240, 240) * k)
    zoomBy(ratio, false)
  }

  function attachWheel() {
    const v = getViewer()
    if (!v || v.isDestroyed() || v === attached) return
    attached = v
    // 关掉默认缩放（顺带也关掉了会「后退」的双击缩放），改由下面自己处理
    v.scene.screenSpaceCameraController.enableZoom = false
    v.scene.canvas.addEventListener('wheel', onWheel, { passive: false })
  }

  onBeforeUnmount(() => {
    if (attached && !attached.isDestroyed()) {
      attached.scene.canvas.removeEventListener('wheel', onWheel)
      attached.scene.screenSpaceCameraController.enableZoom = true
    }
    attached = null
  })

  /**
   * 首次进入：如果页面给了 focus，就按包围球取景（覆盖页面里那句 setView(home)）。
   * 轮询而不是 onMounted，是因为 viewer 在各页 onMounted 里才创建，时机不统一。
   */
  {
    // 等页面把数据准备好（有的 focus 要等地形采样 / 瓦片加载），最多等 6 秒
    let tries = 0
    const tick = () => {
      attachWheel()
      const v = getViewer()
      const home = v && !v.isDestroyed() ? safeHome() : null
      if (v && home && home.focus) {
        viewFocus(v, home, home.focus.range ?? home.focus.radius * 2.6, 0)
        return
      }
      if (tries++ < 360) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  async function toggleFullscreen(el?: HTMLElement) {
    if (!el) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.requestFullscreen()
  }
  return { zoomIn, zoomOut, reset, toggleFullscreen }
}

/**
 * 只把 viewer 交给工具栏（量测用），不接管相机。
 * 给那些自己实现缩放的示例用，一行接入。
 */
export function useCesiumHost(getViewer: () => Viewer | null): void {
  provideMapHost(() => {
    const v = getViewer()
    return v ? { kind: 'cesium', instance: v } : null
  })
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
