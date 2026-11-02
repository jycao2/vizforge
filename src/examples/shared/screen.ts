/**
 * 大屏系列示例的公共数据与几何工具
 * ===========================================================================
 * Mapbox（MapLibre）与 Cesium 两套大屏示例共用同一份数据 —— 「同一座城市」在
 * 两个技术栈里画出来必须是同一批楼、同一圈边界、同一条飞线，否则对照着看没有意义。
 *
 * 坐标一律用 [经度, 纬度]（GeoJSON 顺序），Cesium 侧再自己转 Cartesian3。
 */

export interface Zone {
  id: string
  name: string
  center: [number, number]
  radiusKm: number
  /** 运营指标 0~100：决定光墙高度 / 数据柱柱高 / 高亮等级 */
  value: number
}

/** 6 个片区：围着钱江两岸虚构的「城市运营大屏」主场景 */
export const ZONES: Zone[] = [
  { id: 'cbd', name: '中央商务区', center: [120.2145, 30.2452], radiusKm: 1.65, value: 92 },
  { id: 'expo', name: '钱江世纪城', center: [120.2488, 30.2331], radiusKm: 1.9, value: 78 },
  { id: 'binjiang', name: '滨江高新', center: [120.2085, 30.1902], radiusKm: 1.75, value: 86 },
  { id: 'hub', name: '城站枢纽', center: [120.1905, 30.2478], radiusKm: 1.25, value: 61 },
  { id: 'westlake', name: '西湖景区', center: [120.1425, 30.2418], radiusKm: 1.45, value: 44 },
  { id: 'jiubao', name: '九堡智造', center: [120.2865, 30.3095], radiusKm: 1.6, value: 67 },
]

/** 告警 / 热点：涟漪脉冲与扫描光锥都围着这几个点做 */
export const HOTSPOTS = [
  { name: '滨江高新', center: [120.2085, 30.1902] as [number, number], value: 86, level: 'high' },
  { name: '中央商务区', center: [120.2145, 30.2452] as [number, number], value: 72, level: 'mid' },
  { name: '九堡智造', center: [120.2865, 30.3095] as [number, number], value: 48, level: 'low' },
]

/** 片区之间的联系权重，飞线按它决定线宽 */
export const ODS: Array<{ from: string; to: string; v: number }> = [
  { from: 'cbd', to: 'expo', v: 96 },
  { from: 'cbd', to: 'hub', v: 88 },
  { from: 'cbd', to: 'westlake', v: 74 },
  { from: 'cbd', to: 'binjiang', v: 81 },
  { from: 'binjiang', to: 'expo', v: 69 },
  { from: 'hub', to: 'jiubao', v: 57 },
  { from: 'jiubao', to: 'expo', v: 63 },
  { from: 'westlake', to: 'binjiang', v: 52 },
  { from: 'hub', to: 'westlake', v: 66 },
  { from: 'expo', to: 'jiubao', v: 48 },
]

/* ============================ 几何工具 ============================ */

const D2R = Math.PI / 180

/** 1 公里对应的纬度度数（近似球面） */
export const KM_LAT = 110.574

/** 1 公里对应的经度度数：随纬度收缩，杭州一带约为 0.0105°/km */
export function kmToDegLon(km: number, lat: number): number {
  return km / (111.32 * Math.cos(lat * D2R))
}

export function kmToDegLat(km: number): number {
  return km / KM_LAT
}

/** 确定性伪随机：同一个 seed 永远得到同一批楼，两栈才能对上 */
export function rand32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 片区的边界多边形。
 *
 * 不用随机抖动（抖出来像一坨墨渍），而是几条不同频率的正弦叠加 ——
 * 相邻顶点的半径变化连续，画出来才像「规划边界」而不是噪声。
 */
export function nGon(
  center: [number, number],
  radiusKm: number,
  n = 36,
  seed = 1,
  wobble = 0.16,
): Array<[number, number]> {
  const [lon, lat] = center
  const pts: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const k =
      1 +
      wobble * (0.55 * Math.sin(3 * a + seed) + 0.3 * Math.sin(5 * a + seed * 2.1) + 0.15 * Math.sin(7 * a + seed * 0.7))
    const r = radiusKm * k
    pts.push([lon + kmToDegLon(r * Math.cos(a), lat), lat + kmToDegLat(r * Math.sin(a))])
  }
  pts.push(pts[0])
  return pts
}

/** 轴对齐矩形（可旋转），以中心点 + 宽高（米）+ 旋转角给 */
export function rect(
  center: [number, number],
  widthM: number,
  depthM: number,
  rotDeg = 0,
): Array<[number, number]> {
  const [lon, lat] = center
  const c = Math.cos(rotDeg * D2R)
  const s = Math.sin(rotDeg * D2R)
  const hw = widthM / 2
  const hd = depthM / 2
  const corners: Array<[number, number]> = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([x, y]) => {
    const dx = x * c - y * s
    const dy = x * s + y * c
    return [lon + kmToDegLon(dx / 1000, lat), lat + kmToDegLat(dy / 1000)]
  })
  corners.push(corners[0])
  return corners
}

/**
 * 把一条边界线「加厚」成一组窄四边形。
 *
 * fill-extrusion 只能拉起封闭多边形，画不出「一条竖起来的墙」——
 * 所以把每段边变成一个宽度 2*halfWidth 的细长条带，再整体拉伸，
 * 视觉上就是一堵沿边界走的半透明光墙。这也是 Mapbox 官方 3D 边界线的做法。
 */
export function ringToWall(
  ring: Array<[number, number]>,
  halfWidthM: number,
): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = []
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]
    const b = ring[i]
    const midLat = (a[1] + b[1]) / 2
    // 边长换算成米，再取法线方向（法线在经纬度空间需要按 cos(lat) 校正）
    const dxm = (b[0] - a[0]) * 111.32 * Math.cos(midLat * D2R)
    const dym = (b[1] - a[1]) * KM_LAT
    const len = Math.hypot(dxm, dym) || 1e-6
    const nx = -dym / len
    const ny = dxm / len
    const ox = kmToDegLon((nx * halfWidthM) / 1000, midLat)
    const oy = kmToDegLat((ny * halfWidthM) / 1000)
    out.push([
      [a[0] + ox, a[1] + oy],
      [b[0] + ox, b[1] + oy],
      [b[0] - ox, b[1] - oy],
      [a[0] - ox, a[1] - oy],
      [a[0] + ox, a[1] + oy],
    ])
  }
  return out
}

/** 扇形环（扫描光锥的底面）：从 fromDeg 起扫 sweepDeg，半径 radiusKm */
export function sector(
  center: [number, number],
  radiusKm: number,
  fromDeg: number,
  sweepDeg: number,
  steps = 28,
): Array<[number, number]> {
  const [lon, lat] = center
  const pts: Array<[number, number]> = [[lon, lat]]
  for (let i = 0; i <= steps; i++) {
    const a = (fromDeg + (sweepDeg * i) / steps) * D2R
    pts.push([lon + kmToDegLon(radiusKm * Math.cos(a), lat), lat + kmToDegLat(radiusKm * Math.sin(a))])
  }
  pts.push([lon, lat])
  return pts
}

/** 圆环（地面刻度圈） */
export function circleRing(
  center: [number, number],
  radiusKm: number,
  n = 72,
): Array<[number, number]> {
  const [lon, lat] = center
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push([lon + kmToDegLon(radiusKm * Math.cos(a), lat), lat + kmToDegLat(radiusKm * Math.sin(a))])
  }
  return pts
}

/* ============================ 场景数据 ============================ */

export interface Building {
  ring: Array<[number, number]>
  height: number
  floor: number
}

/**
 * 程序化楼块：每个片区里撒一圈小矩形，越高越靠中心 —— 这样远景自然形成天际线。
 * 560 栋左右，两栈都能流畅拉起来。
 */
export function buildings(seed = 20261102): Building[] {
  const rnd = rand32(seed)
  const out: Building[] = []
  ZONES.forEach((z, zi) => {
    const count = zi === 0 ? 150 : 70
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2
      // sqrt 让点在圆内均匀分布，否则全挤在中心
      const r = Math.sqrt(rnd()) * z.radiusKm * 0.86
      const c: [number, number] = [
        z.center[0] + kmToDegLon(r * Math.cos(a), z.center[1]),
        z.center[1] + kmToDegLat(r * Math.sin(a)),
      ]
      const inner = 1 - r / (z.radiusKm * 0.86)
      const h = 18 + Math.pow(inner, 1.7) * (30 + z.value * 1.5) * (0.55 + rnd() * 0.9)
      out.push({
        ring: rect(c, 26 + rnd() * 34, 26 + rnd() * 34, rnd() * 90),
        height: Math.round(h),
        floor: 0,
      })
    }
  })
  return out
}

export interface Bar {
  zone: string
  center: [number, number]
  ring: Array<[number, number]>
  value: number
}

/** 12 根数据柱：撒在 CBD 与世纪城之间，柱高对应指标 */
export function bars(seed = 77): Bar[] {
  const rnd = rand32(seed)
  const slots: Array<[string, [number, number]]> = [
    ['cbd', [120.2072, 30.2468]],
    ['cbd', [120.2108, 30.2432]],
    ['cbd', [120.2162, 30.2475]],
    ['cbd', [120.2198, 30.2438]],
    ['cbd', [120.2128, 30.2501]],
    ['cbd', [120.2052, 30.2428]],
    ['expo', [120.2432, 30.2352]],
    ['expo', [120.2472, 30.2318]],
    ['expo', [120.2512, 30.2356]],
    ['expo', [120.2452, 30.2288]],
    ['binjiang', [120.2052, 30.1922]],
    ['binjiang', [120.2112, 30.1888]],
  ]
  return slots.map(([zone, center], i) => ({
    zone,
    center,
    ring: rect(center, 190, 190),
    value: Math.round(30 + rnd() * 70 + (i % 3) * 6),
  }))
}

/* ============================ 小工具 ============================ */

/** 数字千分位 */
export function fmt(n: number): string {
  return n.toLocaleString('zh-CN')
}

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

/** 大屏常用的「滚数字」：把 0→target 的进度映射成带缓动的整数 */
export function countUp(target: number, t: number): number {
  return Math.round(target * easeOutCubic(Math.max(0, Math.min(1, t))))
}
