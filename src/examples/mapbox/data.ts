/**
 * Mapbox 示例共用的数据工具
 * ===========================================================================
 * 全部程序化生成，不依赖后端：打开示例就有数据，缩放几级也不会变空。
 * 随机数一律走固定种子的 mulberry32 —— 同一个示例每次刷新看到的是同一份数据，
 * 方便对照「改了样式参数之后画面差在哪」。
 */

export interface City {
  name: string
  c: [number, number]
  /** 示例里当作统计值用（分级填色、柱高、热力权重） */
  v: number
}

export const CITIES: City[] = [
  { name: '北京', c: [116.39, 39.91], v: 96 },
  { name: '上海', c: [121.47, 31.23], v: 92 },
  { name: '广州', c: [113.26, 23.13], v: 78 },
  { name: '深圳', c: [114.06, 22.55], v: 81 },
  { name: '成都', c: [104.07, 30.57], v: 68 },
  { name: '重庆', c: [106.55, 29.56], v: 64 },
  { name: '武汉', c: [114.31, 30.59], v: 66 },
  { name: '西安', c: [108.94, 34.34], v: 59 },
  { name: '杭州', c: [120.15, 30.27], v: 74 },
  { name: '南京', c: [118.78, 32.06], v: 71 },
  { name: '天津', c: [117.2, 39.13], v: 62 },
  { name: '苏州', c: [120.62, 31.32], v: 70 },
  { name: '长沙', c: [112.94, 28.23], v: 55 },
  { name: '郑州', c: [113.63, 34.75], v: 57 },
  { name: '青岛', c: [120.38, 36.07], v: 53 },
  { name: '沈阳', c: [123.43, 41.8], v: 49 },
  { name: '昆明', c: [102.83, 24.88], v: 45 },
  { name: '厦门', c: [118.09, 24.48], v: 47 },
  { name: '哈尔滨', c: [126.53, 45.8], v: 41 },
  { name: '乌鲁木齐', c: [87.62, 43.79], v: 33 },
  { name: '拉萨', c: [91.11, 29.65], v: 22 },
  { name: '兰州', c: [103.83, 36.06], v: 38 },
]

/** 固定种子伪随机，保证每次刷新数据一致 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller 正态随机，用来做「围绕中心的簇」 */
export function gaussian(rnd: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rnd()
  while (v === 0) v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export type P = Record<string, unknown>

export function feat(geometry: GeoJSON.Geometry, properties: P = {}): GeoJSON.Feature {
  return { type: 'Feature', properties, geometry }
}

export function fc(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features }
}

/**
 * 多簇散点：围绕若干中心按正态分布撒点。
 * 热力图、聚合、大数据量性能这几个示例都用它，保证数据分布「像真的」而不是均匀噪声。
 */
export function scatter(
  seed: number,
  count: number,
  centers: Array<[number, number]>,
  spread: number,
): GeoJSON.FeatureCollection {
  const rnd = mulberry32(seed)
  const out: GeoJSON.Feature[] = []
  for (let i = 0; i < count; i++) {
    const ci = i % centers.length
    const [cx, cy] = centers[ci]
    // 纬度方向按 cos(lat) 收缩，否则高纬度的簇会被拉成横向椭圆
    const lon = cx + gaussian(rnd) * spread
    const lat = cy + gaussian(rnd) * spread * 0.72
    out.push(
      feat({ type: 'Point', coordinates: [lon, lat] }, {
        id: i,
        v: Math.round(10 + rnd() * 90),
        cluster: ci,
      }),
    )
  }
  return fc(out)
}

/** 圆多边形（fx 边形），用于掩膜、边界、等时圈一类的填充面 */
export function ring(
  center: [number, number],
  radiusDeg: number,
  steps = 72,
): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    pts.push([center[0] + Math.cos(t) * radiusDeg, center[1] + Math.sin(t) * radiusDeg * 0.72])
  }
  pts.push(pts[0])
  return pts
}

/** 规则网格面（分级统计图用），value 按到中心的距离做梯度，看起来像真实的空间分布 */
export function gridPolygons(
  bbox: [number, number, number, number],
  nx: number,
  ny: number,
): GeoJSON.FeatureCollection {
  const [x0, y0, x1, y1] = bbox
  const dx = (x1 - x0) / nx
  const dy = (y1 - y0) / ny
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const out: GeoJSON.Feature[] = []
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const a: [number, number] = [x0 + i * dx, y0 + j * dy]
      const b: [number, number] = [a[0] + dx, a[1] + dy]
      const mx = (a[0] + b[0]) / 2
      const my = (a[1] + b[1]) / 2
      const d = Math.hypot((mx - cx) / (x1 - x0), (my - cy) / (y1 - y0))
      out.push(
        feat(
          {
            type: 'Polygon',
            coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]],
          },
          { name: `${i + 1}-${j + 1}`, v: Math.round((1 - Math.min(1, d * 1.6)) * 100) },
        ),
      )
    }
  }
  return fc(out)
}

/** 建筑体块：街区网格 + 随机退让，给 fill-extrusion 用 */
export function blocks(
  center: [number, number],
  nx: number,
  ny: number,
  cell: number,
  seed = 7,
): GeoJSON.FeatureCollection {
  const rnd = mulberry32(seed)
  const out: GeoJSON.Feature[] = []
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const pad = cell * (0.12 + rnd() * 0.16)
      const x0 = center[0] + i * cell + pad
      const y0 = center[1] + j * cell + pad * 0.72
      const x1 = center[0] + (i + 1) * cell - pad
      const y1 = center[1] + (j + 1) * cell - pad * 0.72
      // 越靠中心的街区越高，形成 CBD 天际线
      const d = Math.hypot(i - nx / 2, j - ny / 2) / Math.max(nx, ny)
      const h = Math.round((1 - Math.min(1, d * 1.7)) * 180 + rnd() * 60 + 12)
      out.push(
        feat(
          { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
          { height: h, base: 0, name: `B${i}-${j}` },
        ),
      )
    }
  }
  return fc(out)
}

/** 一条带折返的轨迹线，用于轨迹回放 / 飞线 */
export function track(seed = 11, n = 120): Array<[number, number]> {
  const rnd = mulberry32(seed)
  const pts: Array<[number, number]> = []
  let lon = 120.1
  let lat = 30.24
  let ang = 0.6
  for (let i = 0; i < n; i++) {
    ang += (rnd() - 0.5) * 0.5
    lon += Math.cos(ang) * 0.006
    lat += Math.sin(ang) * 0.0045
    pts.push([lon, lat])
  }
  return pts
}
