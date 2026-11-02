/**
 * Cesium 大屏示例的公共场景构件
 * ===========================================================================
 * 六个大屏示例共享同一套「外观设定」与几何构造，避免每页复制一遍：
 *
 *   · applyScreenLook —— 把 Cesium 默认的「蓝色地球 + 大气 + 星空」调成
 *     大屏要的「深空背景 + 暗球体」。这一步不做，后面加多少光效都像白天的 GIS；
 *   · screenHome —— 统一的斜俯视机位（带 focus，复位/缩放都围绕内容）；
 *   · addBuildings —— 程序化楼块。用 Primitive + GeometryInstance 批量提交，
 *     几百个盒子只有一次 draw call；换成 Entity 会慢一个数量级；
 *   · glowLine / zoneWall / arcPositions —— 描边、光墙、飞线的基础件。
 */
import * as Cesium from 'cesium'
import type { Building, Zone } from '@/examples/shared/screen'

/** [经度, 纬度] → Cartesian3 */
export function at(lonLat: [number, number], height = 0): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromDegrees(lonLat[0], lonLat[1], height)
}

/** 经纬度环 → Cartesian3 数组 */
export function ringToPositions(ring: Array<[number, number]>, height = 0): Cesium.Cartesian3[] {
  const flat: number[] = []
  for (const [lon, lat] of ring) flat.push(lon, lat, height)
  return Cesium.Cartesian3.fromDegreesArrayHeights(flat)
}

/** 大屏外观：暗球体 + 深空背景，关掉大气与星空（城市尺度下它们只会抢画面） */
export function applyScreenLook(viewer: Cesium.Viewer) {
  const scene = viewer.scene
  scene.backgroundColor = Cesium.Color.fromCssColorString('#02080f')
  if (scene.skyBox) scene.skyBox.show = false
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#04121f')
  scene.globe.showGroundAtmosphere = false
  scene.fog.enabled = false
  // 关掉太阳光照，否则背光面全黑，楼块会「缺一半」
  scene.globe.enableLighting = false
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false
}

export interface ScreenHome {
  destination: Cesium.Cartesian3
  orientation: { heading: number; pitch: number; roll: number }
  focus: { center: Cesium.Cartesian3; radius: number; range: number }
}

/**
 * 斜俯视机位。range 是相机到焦点的距离（米），pitch 取负值表示俯视。
 * 与 useCesium 里的 focusPose 同一套算式，保证「复位」和页面初始视角一致。
 */
export function screenHome(
  center: [number, number],
  range: number,
  pitchDeg = -48,
  headingDeg = 0,
  radius = range / 2.2,
): ScreenHome {
  const c = at(center)
  const heading = Cesium.Math.toRadians(headingDeg)
  const pitch = Cesium.Math.toRadians(pitchDeg)
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(c)
  const local = new Cesium.Cartesian3(
    Math.cos(pitch) * Math.sin(heading),
    Math.cos(pitch) * Math.cos(heading),
    Math.sin(pitch),
  )
  const view = Cesium.Matrix4.multiplyByPointAsVector(enu, local, new Cesium.Cartesian3())
  const destination = Cesium.Cartesian3.subtract(
    c,
    Cesium.Cartesian3.multiplyByScalar(view, range, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  return {
    destination,
    orientation: { heading, pitch, roll: 0 },
    focus: { center: c, radius, range },
  }
}

/** 楼高 → 颜色：低矮深蓝、超高层青白，和 MapLibre 那套保持一致 */
export function buildingColor(h: number): Cesium.Color {
  const t = Math.max(0, Math.min(1, (h - 20) / 200))
  return Cesium.Color.lerp(
    Cesium.Color.fromCssColorString('#0d2b46'),
    Cesium.Color.fromCssColorString('#6fd0f0'),
    t,
    new Cesium.Color(),
  ).withAlpha(0.94)
}

/**
 * 批量楼块。
 *
 * Entity 写起来简单，但 500 个盒子就是 500 个 primitive、500 次状态切换；
 * 这里用 GeometryInstance 一次性提交，GPU 侧只有一次 draw call，
 * 颜色走 PerInstanceColor 属性，不需要材质。
 */
export function addBuildings(viewer: Cesium.Viewer, list: Building[]): Cesium.Primitive {
  const instances: Cesium.GeometryInstance[] = []
  for (const b of list) {
    // ring 是 5 个点的闭合环，前 4 个是角点
    let lon = 0
    let lat = 0
    for (let i = 0; i < 4; i++) {
      lon += b.ring[i][0]
      lat += b.ring[i][1]
    }
    lon /= 4
    lat /= 4
    const w = Math.abs(b.ring[1][0] - b.ring[0][0]) * 111320 * Math.cos((lat * Math.PI) / 180) * 1.6 || 30
    const d = Math.abs(b.ring[2][1] - b.ring[1][1]) * 110574 * 1.6 || 30
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(at([lon, lat], b.height / 2))
    const hw = Math.max(w, 14) / 2
    const hd = Math.max(d, 14) / 2
    instances.push(
      new Cesium.GeometryInstance({
        // BoxGeometry 只认 minimum/maximum（没有 dimensions 这个入参），
        // 以原点为中心就是 ±半边长 —— 再靠 modelMatrix 摆到「楼高一半」的位置
        geometry: new Cesium.BoxGeometry({
          minimum: new Cesium.Cartesian3(-hw, -hd, -b.height / 2),
          maximum: new Cesium.Cartesian3(hw, hd, b.height / 2),
        }),
        modelMatrix,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(buildingColor(b.height)),
        },
      }),
    )
  }
  const primitive = new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: true }),
    asynchronous: false,
  })
  viewer.scene.primitives.add(primitive)
  return primitive
}

/** 发光描边：PolylineGlowMaterial（glowPower 越大，辉光越往里吃） */
export function glowLine(
  viewer: Cesium.Viewer,
  positions: Cesium.Cartesian3[],
  opts: { color?: string; width?: number; glow?: number; alpha?: number } = {},
): Cesium.Entity {
  return viewer.entities.add({
    polyline: {
      positions,
      width: opts.width ?? 2,
      clampToGround: false,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: opts.glow ?? 0.22,
        taperPower: 1,
        color: Cesium.Color.fromCssColorString(opts.color ?? '#5fd8ff').withAlpha(opts.alpha ?? 0.9),
      }),
    },
  })
}

/** 片区光墙：max/min 高度数组长度必须与 positions 一致 */
export function zoneWall(
  viewer: Cesium.Viewer,
  zone: Zone,
  ring: Array<[number, number]>,
  opts: { height: number; color?: string; alpha?: number },
): Cesium.Entity {
  const positions = ringToPositions(ring)
  const n = positions.length
  return viewer.entities.add({
    wall: {
      positions,
      maximumHeights: new Array(n).fill(opts.height),
      minimumHeights: new Array(n).fill(0),
      material: Cesium.Color.fromCssColorString(opts.color ?? '#2ea8ff').withAlpha(opts.alpha ?? 0.35),
    },
  })
}

/** 端点之间的抛物线（经纬度线性插值 + 正弦抬升），飞线用 */
export function arcPositions(
  a: [number, number],
  b: [number, number],
  lift: number,
  seg = 64,
): Cesium.Cartesian3[] {
  const out: Cesium.Cartesian3[] = []
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    const lon = a[0] + (b[0] - a[0]) * t
    const lat = a[1] + (b[1] - a[1]) * t
    out.push(Cesium.Cartesian3.fromDegrees(lon, lat, Math.sin(Math.PI * t) * lift))
  }
  return out
}

/** 飞线动画的时间原点：只取一次，别在每帧的回调里再调 now() */
const FLOW_EPOCH = Cesium.JulianDate.now()

/** 飞线上的「跑点」：返回一个随时间沿弧长前进的 CallbackProperty 位置 */
export function movingAlong(
  positions: Cesium.Cartesian3[],
  speed = 0.18,
  offset = 0,
): Cesium.CallbackProperty {
  return new Cesium.CallbackProperty((time) => {
    const secs = time ? Cesium.JulianDate.secondsDifference(time, FLOW_EPOCH) : 0
    let t = (secs * speed + offset) % 1
    if (t < 0) t += 1
    const f = t * (positions.length - 1)
    const i = Math.min(positions.length - 2, Math.floor(f))
    const k = f - i
    return Cesium.Cartesian3.lerp(positions[i], positions[i + 1], k, new Cesium.Cartesian3())
  }, false)
}

/** 点精灵：用 canvas 画的径向光斑当 billboard，比 point 好看且不受距离衰减影响 */
export function glowSprite(size = 64, inner = 'rgba(220,250,255,0.95)') {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, inner)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return c.toDataURL()
}
