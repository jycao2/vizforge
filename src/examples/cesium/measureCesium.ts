/**
 * Cesium 量测：测距 / 测面 / 测高
 * ===========================================================================
 * 和二维不同，三维的拾取点自带地形高程：
 *   - 用 globe.pick(ray) 打到真实地表（开了 World Terrain 就是山体表面），
 *     拿不到时退回椭球面，避免点在天空里没反应；
 *   - 测距用 EllipsoidGeodesic.surfaceDistance（测地线），不是 Cartesian3.distance
 *     ——后者算的是空间直线，翻山越岭时会明显偏短；
 *   - 测高直接读两个点的 Cartographic.height 差值，再给水平距离与坡度。
 *
 * 交互：左键选点，右键结束（双击会先触发两次左键，点数会多两个，所以不用双击）。
 */
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import {
  createMeasureTip,
  fmtArea,
  fmtLength,
  sphericalArea,
  type MeasureHandle,
  type MeasureUpdate,
} from '@/components/measureShared'

const ACCENT = Cesium.Color.fromCssColorString('#4f9dff')
const ACCENT_SOFT = Cesium.Color.fromCssColorString('#7bbcff')

export function startCesiumMeasure(
  viewer: Viewer,
  kind: 'line' | 'area' | 'height',
  onUpdate: (u: MeasureUpdate) => void = () => {},
): MeasureHandle {
  const scene = viewer.scene
  const host = viewer.container as HTMLElement
  const tip = createMeasureTip(host)
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)

  const pts: Cesium.Cartesian3[] = []
  const entityIds: string[] = []
  let cursor: Cesium.Cartesian3 | null = null
  let lineId: string | null = null
  let polyId: string | null = null
  let previewId: string | null = null
  let stopped = false

  const add = (opt: Cesium.Entity.ConstructorOptions): Cesium.Entity => {
    const e = viewer.entities.add(opt)
    entityIds.push(e.id)
    return e
  }

  /**
   * 拾取地表点。
   *
   * 不用 globe.pick(ray)：它走深度缓冲，相机拉远时深度精度差，转成
   * Cartographic 会读出 -2904 m 这种地下高度（实测 basic-globe 必现）。
   * 改成「椭球面解析解 + globe.getHeight 查地形高度」：
   *   经度/纬度由解析解给出，精度稳定；地形瓦片已加载就叠上真实高程，
   *   没加载（或该页没开地形）就是 0，不会出现负海拔。
   */
  function pickAt(pos: Cesium.Cartesian2): Cesium.Cartesian3 | null {
    const onEllipsoid = viewer.camera.pickEllipsoid(pos, scene.globe.ellipsoid)
    if (!onEllipsoid) return null
    const carto = Cesium.Cartographic.fromCartesian(onEllipsoid)
    const terr = scene.globe.getHeight(carto)
    const h = Number.isFinite(terr) ? (terr as number) : 0
    return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, h)
  }

  /** 当前页面是否启用了真实地形（决定测高读数是否可信） */
  const hasTerrain = !(scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)

  const toCarto = (c: Cesium.Cartesian3) => Cesium.Cartographic.fromCartesian(c)

  /** 测地线长度（米） */
  function geodesic(a: Cesium.Cartographic, b: Cesium.Cartographic): number {
    return new Cesium.EllipsoidGeodesic(a, b).surfaceDistance
  }

  function ringOf(list: Cesium.Cartesian3[]): Array<[number, number]> {
    return list.map((c) => {
      const ca = toCarto(c)
      return [Cesium.Math.toDegrees(ca.longitude), Cesium.Math.toDegrees(ca.latitude)] as [number, number]
    })
  }

  /** 依据当前点集计算读数 */
  function compute(extra?: Cesium.Cartesian3): MeasureUpdate {
    const list = extra ? [...pts, extra] : pts
    if (list.length < 2) {
      return { text: kind === 'height' ? '选第一个点' : '选点中', detail: '左键选点 · 右键结束', done: false }
    }
    if (kind === 'height') {
      const c1 = toCarto(list[0])
      const c2 = toCarto(list[1])
      const dh = c2.height - c1.height
      const hd = geodesic(c1, c2)
      const slope = hd > 0.01 ? (Math.atan(Math.abs(dh) / hd) * 180) / Math.PI : 0
      const sign = dh >= 0 ? '+' : '−'
      return {
        text: `高差 ${sign}${Math.abs(dh).toFixed(1)} m`,
        detail: hasTerrain
          ? `水平 ${fmtLength(hd)} · 坡度 ${slope.toFixed(1)}° · 海拔 ${c1.height.toFixed(0)}→${c2.height.toFixed(0)} m`
          : `水平 ${fmtLength(hd)} · 本页未开地形，仅有椭球面`,
        done: false,
      }
    }
    // 折线长度
    let len = 0
    for (let i = 1; i < list.length; i++) len += geodesic(toCarto(list[i - 1]), toCarto(list[i]))
    if (kind === 'line') {
      return { text: fmtLength(len), detail: `${list.length} 个节点`, done: false }
    }
    // 面：面积用球面公式，周长复用折线长度（闭合再加一条）
    if (list.length < 3) {
      return { text: fmtLength(len), detail: '至少 3 个点成面', done: false }
    }
    const closed = [...list, list[0]]
    let peri = 0
    for (let i = 1; i < closed.length; i++) peri += geodesic(toCarto(closed[i - 1]), toCarto(closed[i]))
    return { text: fmtArea(sphericalArea(ringOf(list))), detail: `周长 ${fmtLength(peri)}`, done: false }
  }

  /** 同步图形：点、连线/面、预览虚线 */
  function redraw(preview?: Cesium.Cartesian3 | null) {
    if (kind !== 'height') {
      const path = preview ? [...pts, preview] : pts
      if (!lineId) {
        lineId = add({
          polyline: {
            positions: path,
            width: 2.4,
            material: ACCENT,
            clampToGround: kind === 'line',
          },
        }).id
      } else {
        const e = viewer.entities.getById(lineId)
        if (e?.polyline) e.polyline.positions = new Cesium.ConstantProperty(path) as never
      }
    }

    if (kind === 'area' && pts.length >= 3) {
      if (!polyId) {
        polyId = add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(pts),
            material: ACCENT.withAlpha(0.22),
            classificationType: Cesium.ClassificationType.TERRAIN,
          },
        }).id
      } else {
        const e = viewer.entities.getById(polyId)
        if (e?.polygon) e.polygon.hierarchy = new Cesium.ConstantProperty(new Cesium.PolygonHierarchy(pts)) as never
      }
    }
  }

  function addVertex(c: Cesium.Cartesian3) {
    pts.push(c)
    add({
      position: c,
      point: {
        pixelSize: 7,
        color: Cesium.Color.WHITE,
        outlineColor: ACCENT,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  function finish() {
    if (stopped) return
    stopped = true
    handler.destroy()
    if (previewId) {
      viewer.entities.removeById(previewId)
      previewId = null
    }
    const u = compute()
    onUpdate({ ...u, done: true })
    // 完成后收起浮标：右上角读数条已经在显示同一组数字，两个一起出现反而挡视线
    tip.hide()
  }

  // ---- 交互 ----
  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (stopped) return
    const c = pickAt(e.position)
    if (!c) return
    addVertex(c)
    redraw()
    const u = compute()
    onUpdate(u)
    tip.set(u.text, u.detail)
    // 测高只需要两个点
    if (kind === 'height' && pts.length >= 2) finish()
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    if (stopped) return
    const c = pickAt(e.endPosition)
    cursor = c
    if (c) {
      const canvas = scene.cartesianToCanvasCoordinates(c)
      if (canvas) tip.moveTo(canvas.x, canvas.y)
      if (pts.length) {
        redraw(c)
        const u = compute(c)
        tip.set(u.text, u.detail)
      }
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

  handler.setInputAction(() => finish(), Cesium.ScreenSpaceEventType.RIGHT_CLICK)

  const first = compute()
  tip.set(first.text, first.detail)
  onUpdate(first)
  void cursor

  return {
    stop() {
      if (!stopped) finish()
    },
    dispose() {
      if (!stopped) {
        stopped = true
        handler.destroy()
      }
      for (const id of entityIds) viewer.entities.removeById(id)
      entityIds.length = 0
      tip.destroy()
    },
  }
}
