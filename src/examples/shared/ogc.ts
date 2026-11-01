/**
 * 浏览器内的 OGC 地图服务（参数与 GeoServer 对齐）
 * ===========================================================================
 * 这个示例要讲的是"地图服务"这一环：图层目录、WMS GetMap 出图、CQL 属性过滤、
 * WFS 要素查询、GetFeatureInfo 点查、GetCapabilities 能力文档。
 *
 * 公开的 GeoServer 实例（ahocevar / geo-solutions / FAO）经常 403 或直接下线，
 * 示例一旦依赖它们就会随机变白屏。所以这里把服务端搬到浏览器里：
 * 参数名、语义、返回格式全部照 GeoServer 实现，只是"渲染瓦片"这一步换成本地
 * Canvas 光栅化。想接真实服务时，把请求 URL 的 host 换掉即可，客户端代码不用动。
 *
 * 服务端能力：
 *   - WMS 1.3.0  GetCapabilities / GetMap / GetFeatureInfo
 *   - WFS 2.0    GetFeature（GeoJSON）
 *   - CQL 子集   >、<、>=、<=、=、!=、LIKE，支持 AND / OR
 * ===========================================================================
 */

/* ------------------------------- 类型 ------------------------------- */

export type GeomType = 'Point' | 'LineString' | 'Polygon'

/** 分级配色：按属性值取色，等价于 SLD 的 <ColorMap> */
export interface Ramp {
  field: string
  stops: Array<[number, string]>
}

/** 简化版 SLD：面填色 / 线色 / 点半径 / 分级配色 */
export interface StyleSpec {
  fill?: string
  stroke?: string
  width?: number
  radius?: number
  ramp?: Ramp
  /** 图层自身透明度（叠在 WMS 的 opacity 之上） */
  opacity?: number
}

export interface LayerMeta {
  /** 带工作区前缀，和 GeoServer 的 "workspace:layer" 命名一致 */
  name: string
  title: string
  type: GeomType
  crs: string
  style: StyleSpec
  fields: Array<{ name: string; type: 'string' | 'number'; note?: string }>
  /** 图层说明，展示在目录里 */
  note: string
}

interface Feat {
  id: number
  geom: GeomType
  /** 经纬度：点 [lon,lat]、线 [[lon,lat]..]、面 [[lon,lat]..]（单环） */
  coords: number[] | number[][] | number[][][]
  props: Record<string, string | number>
  /** 经纬度 bbox: [w, s, e, n] */
  bbox: [number, number, number, number]
}

interface LayerData {
  meta: LayerMeta
  feats: Feat[]
  /** 0.25° 空间索引：cellKey → 要素下标 */
  index: Map<number, number[]>
  /** 已用过的最大要素 id，insert 时自增 */
  seq: number
}

/* ------------------------------- 常量 ------------------------------- */

export const SERVICE_TITLE = 'VizForge OGC Service'
/** Web Mercator 世界宽度（米） */
export const WORLD = 40075016.68557849
const R = 6378137
const RAD = Math.PI / 180
const CELL = 0.25
/** 研究区（长三角） */
export const EXTENT = { w: 118.2, s: 29.2, e: 122.2, n: 32.8 }

/* ----------------------------- 确定性随机 ----------------------------- */

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------ 几何工具 ------------------------------ */

function ringBBox(ring: number[][]): [number, number, number, number] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const p of ring) {
    if (p[0] < w) w = p[0]
    if (p[0] > e) e = p[0]
    if (p[1] < s) s = p[1]
    if (p[1] > n) n = p[1]
  }
  return [w, s, e, n]
}

function cellKey(lon: number, lat: number): number {
  return (Math.floor(lon / CELL) + 360) * 1000 + (Math.floor(lat / CELL) + 180)
}

/* ------------------------------ 数据生成 ------------------------------ */

/** 长三角主要城市：经纬度与建成区规模（相对值，用来定轮廓半径） */
const CITIES: Array<[string, number, number, number, number]> = [
  // 名称, lon, lat, 半径(度), 人口(万)
  ['上海', 121.47, 31.23, 0.34, 2487],
  ['苏州', 120.58, 31.3, 0.2, 1275],
  ['无锡', 120.3, 31.57, 0.15, 746],
  ['常州', 119.97, 31.81, 0.12, 528],
  ['南京', 118.8, 32.06, 0.22, 931],
  ['镇江', 119.42, 32.19, 0.09, 321],
  ['扬州', 119.41, 32.39, 0.1, 456],
  ['南通', 120.89, 31.98, 0.13, 772],
  ['泰州', 119.92, 32.46, 0.09, 451],
  ['杭州', 120.15, 30.27, 0.22, 1220],
  ['嘉兴', 120.75, 30.75, 0.1, 540],
  ['湖州', 120.09, 30.89, 0.09, 336],
  ['绍兴', 120.58, 30.0, 0.11, 527],
  ['宁波', 121.55, 29.87, 0.17, 954],
  ['舟山', 122.16, 29.99, 0.07, 116],
  ['昆山', 120.98, 31.39, 0.08, 209],
  ['常熟', 120.75, 31.65, 0.07, 167],
  ['宜兴', 119.82, 31.34, 0.07, 128],
]

/** 生成不规则闭合环，像行政区/建成区轮廓 */
function blob(cx: number, cy: number, r: number, rand: () => number, n = 12): number[][] {
  const pts: number[][] = []
  const phase = rand() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    // 两层扰动：整体形变 + 局部毛刺
    const rr = r * (0.82 + 0.26 * Math.sin(a * 3 + phase) + 0.14 * (rand() - 0.5))
    pts.push([cx + Math.cos(a) * rr * 1.17, cy + Math.sin(a) * rr])
  }
  pts.push(pts[0].slice())
  return pts
}

function buildBuiltup(): Feat[] {
  const rand = rng(20261031)
  const feats: Feat[] = []
  let id = 1
  for (const [name, lon, lat, r, pop] of CITIES) {
    // 主城区
    const main = blob(lon, lat, r, rand, 14)
    feats.push({
      id: id++,
      geom: 'Polygon',
      coords: main,
      bbox: ringBBox(main),
      props: { name, kind: 'main', population: pop, area_km2: Math.round(pop * 0.42 + rand() * 40) },
    })
    // 2~4 个外围组团
    const sub = 2 + Math.floor(rand() * 3)
    for (let k = 0; k < sub; k++) {
      const a = rand() * Math.PI * 2
      const d = r * (1.35 + rand() * 0.9)
      const sx = lon + Math.cos(a) * d * 1.17
      const sy = lat + Math.sin(a) * d
      if (sx < EXTENT.w || sx > EXTENT.e || sy < EXTENT.s || sy > EXTENT.n) continue
      const ring = blob(sx, sy, r * (0.3 + rand() * 0.22), rand, 10)
      feats.push({
        id: id++,
        geom: 'Polygon',
        coords: ring,
        bbox: ringBBox(ring),
        props: {
          name: `${name}${['新区', '开发区', '组团', '片区'][k % 4]}`,
          kind: 'sub',
          population: Math.round(pop * (0.08 + rand() * 0.12)),
          area_km2: Math.round(8 + rand() * 60),
        },
      })
    }
  }
  return feats
}

/** 主干路/高铁：城市对之间插值 + 正弦扰动，避免直线太假 */
function link(a: [number, number], b: [number, number], rand: () => number, wobble = 0.02): number[][] {
  const n = 26
  const pts: number[][] = []
  const amp = wobble * (rand() + 0.4)
  const phase = rand() * Math.PI * 2
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  // 法向量用于横向偏移
  const nx = -dy / len
  const ny = dx / len
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const off = Math.sin(t * Math.PI) * amp * Math.sin(t * 7 + phase)
    pts.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off])
  }
  return pts
}

function buildRoads(): Feat[] {
  const rand = rng(778899)
  const byName = new Map(CITIES.map((c) => [c[0], [c[1], c[2]] as [number, number]]))
  const LINKS: Array<[string, string, string, number]> = [
    // 起点, 终点, 名称, 等级(1 高速 / 2 国道)
    ['南京', '镇江', '沪蓉高速 G42', 1],
    ['镇江', '常州', '沪蓉高速 G42', 1],
    ['常州', '无锡', '沪蓉高速 G42', 1],
    ['无锡', '苏州', '沪蓉高速 G42', 1],
    ['苏州', '上海', '沪蓉高速 G42', 1],
    ['上海', '嘉兴', '沪昆高速 G60', 1],
    ['嘉兴', '杭州', '沪昆高速 G60', 1],
    ['杭州', '绍兴', '杭甬高速 G92', 1],
    ['绍兴', '宁波', '杭甬高速 G92', 1],
    ['扬州', '泰州', '京沪高速 G2', 1],
    ['泰州', '南通', '启扬高速 S28', 1],
    ['南通', '上海', '沈海高速 G15', 1],
    ['南京', '扬州', '长深高速 G25', 1],
    ['无锡', '宜兴', '锡宜高速 S48', 2],
    ['苏州', '昆山', '沪宁高速 G2', 2],
    ['苏州', '常熟', '苏嘉杭 G15W', 2],
    ['湖州', '杭州', '杭宁高速 G25', 2],
    ['嘉兴', '湖州', '申嘉湖 S12', 2],
    ['宁波', '舟山', '甬舟高速 G9211', 1],
    ['常州', '宜兴', '常宜高速 S39', 2],
  ]
  const out: Feat[] = []
  let id = 1
  for (const [a, b, name, level] of LINKS) {
    const pa = byName.get(a)
    const pb = byName.get(b)
    if (!pa || !pb) continue
    const pts = link(pa, pb, rand, 0.018)
    out.push({
      id: id++,
      geom: 'LineString',
      coords: pts,
      bbox: ringBBox(pts),
      props: { name, level, length_km: Math.round(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) * 92) },
    })
  }
  return out
}

/** 长江、钱塘江、京杭运河：手绘关键点后插值加密 */
function buildRivers(): Feat[] {
  const RAW: Array<[string, string, number[][]]> = [
    [
      '长江',
      'river',
      [
        [118.32, 32.12],
        [118.62, 32.16],
        [118.95, 32.22],
        [119.25, 32.24],
        [119.45, 32.2],
        [119.7, 32.16],
        [119.95, 32.1],
        [120.2, 32.05],
        [120.45, 31.98],
        [120.7, 31.95],
        [120.95, 31.92],
        [121.2, 31.85],
        [121.5, 31.78],
        [121.8, 31.72],
        [122.05, 31.66],
      ],
    ],
    [
      '钱塘江',
      'river',
      [
        [118.55, 29.62],
        [118.9, 29.5],
        [119.2, 29.48],
        [119.5, 29.55],
        [119.75, 29.68],
        [119.95, 29.85],
        [120.05, 30.05],
        [120.12, 30.18],
        [120.2, 30.32],
        [120.35, 30.42],
        [120.55, 30.4],
        [120.75, 30.36],
        [120.95, 30.32],
        [121.15, 30.3],
        [121.35, 30.28],
      ],
    ],
    [
      '京杭运河',
      'canal',
      [
        [118.78, 32.08],
        [119.2, 32.0],
        [119.6, 31.9],
        [119.95, 31.75],
        [120.3, 31.58],
        [120.6, 31.35],
        [120.75, 31.15],
        [120.7, 30.9],
        [120.55, 30.7],
        [120.35, 30.45],
        [120.2, 30.3],
      ],
    ],
  ]
  const rand = rng(5150)
  const out: Feat[] = []
  let id = 1
  for (const [name, kind, raw] of RAW) {
    // 每段之间再插值，让线条更顺
    const pts: number[][] = []
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i]
      const b = raw[i + 1]
      for (let k = 0; k < 4; k++) {
        const t = k / 4
        pts.push([a[0] + (b[0] - a[0]) * t + (rand() - 0.5) * 0.004, a[1] + (b[1] - a[1]) * t + (rand() - 0.5) * 0.004])
      }
    }
    pts.push(raw[raw.length - 1].slice())
    out.push({
      id: id++,
      geom: 'LineString',
      coords: pts,
      bbox: ringBBox(pts),
      props: { name, kind, level: kind === 'river' ? 1 : 2 },
    })
  }
  return out
}

/** 感知站点：撒在建成区内及周边，带 PM2.5 / 降雨读数 */
function buildSensors(count = 12000): Feat[] {
  const rand = rng(31337)
  const out: Feat[] = []
  const TYPES = ['空气站', '水位站', '雨量站', '交通流量']
  for (let i = 0; i < count; i++) {
    // 先挑一个城市，再在其周边散布（多数集中在城区，符合真实点位分布）
    const c = CITIES[Math.floor(rand() * CITIES.length)]
    const a = rand() * Math.PI * 2
    // sqrt 让点更集中在中心
    const d = c[3] * (0.35 + Math.sqrt(rand()) * 2.4)
    const lon = c[1] + Math.cos(a) * d * 1.17
    const lat = c[2] + Math.sin(a) * d
    if (lon < EXTENT.w || lon > EXTENT.e || lat < EXTENT.s || lat > EXTENT.n) continue
    const type = TYPES[i % TYPES.length]
    const pm = Math.round(18 + rand() * 96)
    out.push({
      id: i + 1,
      geom: 'Point',
      coords: [lon, lat],
      bbox: [lon, lat, lon, lat],
      props: {
        name: `${type.slice(0, 2)}-${String(i + 1).padStart(5, '0')}`,
        type,
        city: c[0],
        pm25: pm,
        level: pm > 75 ? 'high' : pm > 50 ? 'mid' : 'low',
      },
    })
  }
  return out
}

/**
 * 网格面：0.04° 一格，覆盖研究区。值由几个高斯中心叠加 + 噪声构成，
 * 用来演示 CQL 数值过滤与 SLD 分级配色（等价 GeoServer 的 ColorMap）。
 */
function buildGrid(): Feat[] {
  const rand = rng(90210)
  const STEP = 0.04
  const out: Feat[] = []
  // 污染/降雨中心
  const KERNELS: Array<[number, number, number, number]> = [
    [121.0, 31.6, 0.55, 90],
    [119.6, 31.9, 0.45, 70],
    [120.5, 30.4, 0.5, 62],
    [121.6, 30.9, 0.35, 48],
  ]
  let id = 1
  for (let lat = EXTENT.s; lat < EXTENT.n; lat += STEP) {
    for (let lon = EXTENT.w; lon < EXTENT.e; lon += STEP) {
      let v = 12
      for (const [kx, ky, ks, kw] of KERNELS) {
        const d2 = ((lon - kx) * (lon - kx) + (lat - ky) * (lat - ky)) / (ks * ks)
        v += kw * Math.exp(-d2)
      }
      v += (rand() - 0.5) * 14
      v = Math.max(0, Math.min(120, v))
      const ring = [
        [lon, lat],
        [lon + STEP, lat],
        [lon + STEP, lat + STEP],
        [lon, lat + STEP],
        [lon, lat],
      ]
      out.push({
        id: id++,
        geom: 'Polygon',
        coords: ring,
        bbox: [lon, lat, lon + STEP, lat + STEP],
        props: {
          cell: `G${Math.round(lon * 100)}${Math.round(lat * 100)}`,
          value: Math.round(v * 10) / 10,
          level: v > 80 ? 'high' : v > 45 ? 'mid' : 'low',
        },
      })
    }
  }
  return out
}

/* ------------------------------ 图层装配 ------------------------------ */

const RAMPS: Record<string, Ramp> = {
  pm25: { field: 'pm25', stops: [[0, '#2f9e6f'], [50, '#d8c33a'], [75, '#e0883a'], [110, '#c8322f']] },
  value: {
    field: 'value',
    stops: [
      [0, 'rgba(31,111,139,0)'],
      [22, 'rgba(47,129,157,0.045)'],
      [50, 'rgba(63,169,160,0.62)'],
      [85, 'rgba(232,197,71,0.90)'],
      [120, 'rgba(217,72,47,1)'],
    ],
  },
}

const LAYER_DEFS: Array<{ meta: LayerMeta; build: () => Feat[] }> = [
  {
    meta: {
      name: 'city:grid',
      title: '网格面 · 逐格指标',
      type: 'Polygon',
      crs: 'EPSG:3857',
      note: '0.04° 网格，约 9 千格；演示 CQL 数值过滤 + ColorMap 分级',
      style: { fill: '#3fa9a0', stroke: 'rgba(0,0,0,0)', width: 0, ramp: RAMPS.value },
      fields: [
        { name: 'cell', type: 'string' },
        { name: 'value', type: 'number', note: '指标值 0~120' },
        { name: 'level', type: 'string', note: 'high / mid / low' },
      ],
    },
    build: buildGrid,
  },
  {
    meta: {
      name: 'city:builtup',
      title: '面 · 建成区',
      type: 'Polygon',
      crs: 'EPSG:3857',
      note: '18 个城市主城区 + 外围组团，演示面填充与描边',
      style: { fill: 'rgba(240, 166, 92, 0.55)', stroke: '#f2b45c', width: 1.2 },
      fields: [
        { name: 'name', type: 'string' },
        { name: 'kind', type: 'string', note: 'main / sub' },
        { name: 'population', type: 'number', note: '万人' },
        { name: 'area_km2', type: 'number' },
      ],
    },
    build: buildBuiltup,
  },
  {
    meta: {
      name: 'city:roads',
      title: '线 · 干线公路',
      type: 'LineString',
      crs: 'EPSG:3857',
      note: '20 条高速/国道，width 随等级变化',
      style: { stroke: '#3f8fd0', width: 1.7 },
      fields: [
        { name: 'name', type: 'string' },
        { name: 'level', type: 'number', note: '1 高速 / 2 国道' },
        { name: 'length_km', type: 'number' },
      ],
    },
    build: buildRoads,
  },
  {
    meta: {
      name: 'city:rivers',
      title: '线 · 江河水系',
      type: 'LineString',
      crs: 'EPSG:3857',
      note: '长江、钱塘江、京杭运河',
      style: { stroke: '#2f7fc4', width: 2.6 },
      fields: [
        { name: 'name', type: 'string' },
        { name: 'kind', type: 'string', note: 'river / canal' },
      ],
    },
    build: buildRivers,
  },
  {
    meta: {
      name: 'city:sensors',
      title: '点 · 感知站点',
      type: 'Point',
      crs: 'EPSG:3857',
      note: '约 1.2 万个点，演示 GetFeatureInfo 点查',
      style: { fill: '#8ef0b8', radius: 1.1, ramp: RAMPS.pm25, opacity: 0.85 },
      fields: [
        { name: 'name', type: 'string' },
        { name: 'type', type: 'string', note: '空气站 / 水位站 / 雨量站 / 交通流量' },
        { name: 'city', type: 'string' },
        { name: 'pm25', type: 'number', note: 'μg/m³' },
        { name: 'level', type: 'string', note: 'high / mid / low' },
      ],
    },
    build: () => buildSensors(12000),
  },
]

let layers: LayerData[] | null = null

/** 建 0.25° 空间索引：cellKey → 要素下标 */
function buildIndex(feats: Feat[]): Map<number, number[]> {
  const index = new Map<number, number[]>()
  feats.forEach((f, i) => {
    const [w, s, e, n] = f.bbox
    const ci0 = Math.floor(w / CELL)
    const ci1 = Math.floor(e / CELL)
    const cj0 = Math.floor(s / CELL)
    const cj1 = Math.floor(n / CELL)
    for (let ci = ci0; ci <= ci1; ci++) {
      for (let cj = cj0; cj <= cj1; cj++) {
        const k = (ci + 360) * 1000 + (cj + 180)
        const arr = index.get(k)
        if (arr) arr.push(i)
        else index.set(k, [i])
      }
    }
  })
  return index
}

/** 懒加载：首次访问才生成数据（约 60~120ms） */
function ensure(): LayerData[] {
  if (layers) return layers
  layers = LAYER_DEFS.map(({ meta, build }) => {
    const feats = build()
    return { meta, feats, index: buildIndex(feats), seq: feats.reduce((m, f) => Math.max(m, f.id), 0) }
  })
  return layers
}

/** 目录信息（不需要生成完整数据就能给出标题与要素数） */
export function listLayers(): Array<LayerMeta & { count: number }> {
  return ensure().map((l) => ({ ...l.meta, count: l.feats.length }))
}

export function getLayerMeta(name: string): LayerMeta | null {
  return ensure().find((l) => l.meta.name === name)?.meta ?? null
}

/* ------------------------------- CQL ------------------------------- */

type Props = Record<string, string | number>

function compare(left: string | number, op: string, right: string | number): boolean {
  const bothNum = typeof left === 'number' && typeof right === 'number'
  switch (op) {
    case '>':
      return bothNum ? left > right : String(left) > String(right)
    case '<':
      return bothNum ? left < right : String(left) < String(right)
    case '>=':
      return bothNum ? left >= right : String(left) >= String(right)
    case '<=':
      return bothNum ? left <= right : String(left) <= String(right)
    case '=':
    case '==':
      return bothNum ? left === right : String(left) === String(right)
    case '!=':
    case '<>':
      return bothNum ? left !== right : String(left) !== String(right)
    default:
      return true
  }
}

function unquote(v: string): string | number {
  const t = v.trim()
  if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1)
  const n = Number(t)
  return Number.isFinite(n) ? n : t
}

/** 单条条件：`pm25 > 75` / `level = 'high'` / `name LIKE '苏州%'` */
function evalCondition(cond: string, props: Props): boolean {
  const m = cond.match(/^\s*([A-Za-z_][\w.]*)\s*(>=|<=|!=|<>|==|=|>|<)\s*(.+?)\s*$/)
  if (m) {
    const [, field, op, rawVal] = m
    const v = props[field]
    if (v === undefined) return false
    return compare(v, op, unquote(rawVal))
  }
  const like = cond.match(/^\s*([A-Za-z_][\w.]*)\s+LIKE\s+(.+?)\s*$/i)
  if (like) {
    const [, field, rawVal] = like
    const v = props[field]
    if (v === undefined) return false
    const pattern = String(unquote(rawVal))
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.')
    return new RegExp('^' + pattern + '$').test(String(v))
  }
  return true
}

/**
 * CQL 子集解析：支持 AND / OR，条件可以整体加一层括号。
 * 真实 GeoServer 走 GeoTools 的 ECQL 解析器，这里只覆盖示例用得到的部分。
 */
export function parseCql(expr: string): ((props: Props) => boolean) | null {
  const src = expr.trim()
  if (!src) return null
  // 顶层 OR 优先（"a=1 and b=2 or c=3" 按 (a=1 and b=2) or c=3 处理）
  const orParts = splitTop(src, /\s+OR\s+/i)
  if (orParts.length > 1) {
    const fns = orParts.map((p) => parseCql(p)).filter(Boolean) as Array<(p: Props) => boolean>
    if (!fns.length) return null
    return (props) => fns.some((f) => f(props))
  }
  const andParts = splitTop(src, /\s+AND\s+/i)
  if (andParts.length > 1) {
    const fns = andParts.map((p) => parseCql(p)).filter(Boolean) as Array<(p: Props) => boolean>
    if (!fns.length) return null
    return (props) => fns.every((f) => f(props))
  }
  // 整体括号
  if (src.startsWith('(') && src.endsWith(')')) {
    return parseCql(src.slice(1, -1))
  }
  return (props) => evalCondition(src, props)
}

/** 只在括号外按分隔符切分 */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    if (depth === 0) {
      const rest = s.slice(i)
      const m = rest.match(sep)
      if (m && m.index === 0) {
        out.push(s.slice(last, i))
        last = i + m[0].length
        i = last - 1
      }
    }
  }
  out.push(s.slice(last))
  return out.filter((p) => p.trim())
}

/* ------------------------------ 投影与绘制 ------------------------------ */

function mercX(lon: number): number {
  return R * lon * RAD
}
function mercY(lat: number): number {
  const l = Math.max(-85, Math.min(85, lat))
  return R * Math.log(Math.tan(Math.PI / 4 + (l * RAD) / 2))
}

function rampColor(ramp: Ramp | undefined, props: Props, fallback: string): string {
  if (!ramp) return fallback
  const v = Number(props[ramp.field])
  if (!Number.isFinite(v)) return fallback
  const stops = ramp.stops
  if (v <= stops[0][0]) return stops[0][1]
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [v0, c0] = stops[i - 1]
      const [v1, c1] = stops[i]
      const t = (v - v0) / (v1 - v0 || 1)
      return mixHex(c0, c1, t)
    }
  }
  return stops[stops.length - 1][1]
}

type RGBA = [number, number, number, number]

/** 解析 #rrggbb 或 rgba(r,g,b,a)，统一成 [r,g,b,a] */
function parseColor(c: string): RGBA {
  const s = c.trim()
  if (s.startsWith('#')) {
    const h = s.slice(1)
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ]
  }
  const m = s.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(',').map((v) => Number(v.trim()))
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]
  }
  return [128, 128, 128, 1]
}

/**
 * 颜色插值（含 alpha）。让分级配色的第一档从"全透明"起步，
 * 低值区自然淡出，叠加在底图上才像热力云团而不是一块玻璃板。
 */
function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1, a1] = parseColor(a)
  const [r2, g2, b2, a2] = parseColor(b)
  const k = Math.max(0, Math.min(1, t))
  const r = Math.round(r1 + (r2 - r1) * k)
  const g = Math.round(g1 + (g2 - g1) * k)
  const bb = Math.round(b1 + (b2 - b1) * k)
  const al = a1 + (a2 - a1) * k
  return al >= 0.999 ? `rgb(${r},${g},${bb})` : `rgba(${r},${g},${bb},${al.toFixed(3)})`
}

/* ------------------------------ 服务实现 ------------------------------ */

export interface RequestLog {
  seq: number
  op: 'GetMap' | 'GetTile' | 'GetFeature' | 'GetFeatureInfo' | 'GetCapabilities' | 'Transaction'
  layers: string[]
  z?: number
  x?: number
  y?: number
  ms: number
  features: number
  url: string
}

export interface ServiceStats {
  requests: number
  tiles: number
  avgMs: number
  maxMs: number
  features: number
  last: RequestLog | null
}

const stats: ServiceStats = { requests: 0, tiles: 0, avgMs: 0, maxMs: 0, features: 0, last: null }
let seq = 0

function record(op: RequestLog['op'], info: Omit<RequestLog, 'seq' | 'op'>): void {
  const log: RequestLog = { seq: ++seq, op, ...info }
  stats.requests++
  if (op === 'GetMap') stats.tiles++
  stats.avgMs = stats.avgMs * 0.85 + info.ms * 0.15
  stats.maxMs = Math.max(stats.maxMs, info.ms)
  stats.features += info.features
  stats.last = log
  for (const fn of listeners) fn(log)
}

const listeners = new Set<(l: RequestLog) => void>()

export function onRequest(fn: (l: RequestLog) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getStats(): ServiceStats {
  return { ...stats }
}

export function resetStats(): void {
  stats.requests = 0
  stats.tiles = 0
  stats.avgMs = 0
  stats.maxMs = 0
  stats.features = 0
  stats.last = null
}

/* ------------------------------ GetMap ------------------------------ */

export interface GetMapParams {
  /** 逗号分隔，可多层 */
  layers: string[]
  /** [minX, minY, maxX, maxY]，EPSG:3857 米 */
  bbox: [number, number, number, number]
  width: number
  height: number
  /** CQL 过滤表达式，按图层名可分别指定：{ 'city:grid': 'value > 60' } */
  cql?: Record<string, string>
  /** 覆盖样式（可选） */
  overrides?: Record<string, StyleSpec>
  /** 每层不透明度 0~1 */
  opacity?: Record<string, number>
  /** 瓦片坐标（仅用于日志展示） */
  tile?: [number, number, number]
  /** 内部调用（如 WMTS 切片）不重复记日志 */
  silent?: boolean
}

export interface GetMapResult {
  image: ImageData
  ms: number
  features: number
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function makeCanvas(w: number, h: number): { ctx: Ctx2D; get: () => ImageData } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')!
    return { ctx, get: () => ctx.getImageData(0, 0, w, h) }
  }
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  return { ctx, get: () => ctx.getImageData(0, 0, w, h) }
}

/** 取与 bbox 相交的要素下标（走 0.25° 空间索引） */
function query(layer: LayerData, w: number, s: number, e: number, n: number): number[] {
  const ci0 = Math.floor(w / CELL)
  const ci1 = Math.floor(e / CELL)
  const cj0 = Math.floor(s / CELL)
  const cj1 = Math.floor(n / CELL)
  const seen = new Set<number>()
  for (let ci = ci0; ci <= ci1; ci++) {
    for (let cj = cj0; cj <= cj1; cj++) {
      const arr = layer.index.get((ci + 360) * 1000 + (cj + 180))
      if (!arr) continue
      for (const i of arr) seen.add(i)
    }
  }
  return Array.from(seen)
}

/**
 * WMS GetMap：把图层光栅化成 ImageData。
 * 与 GeoServer 一样，BBOX 用米（EPSG:3857），要素坐标是经纬度，绘制前投影。
 */
export function getMap(p: GetMapParams): GetMapResult {
  const t0 = performance.now()
  const { bbox, width, height } = p
  const [minX, minY, maxX, maxY] = bbox
  const sx = width / (maxX - minX)
  const sy = height / (maxY - minY)
  const px = (lon: number) => (mercX(lon) - minX) * sx
  const py = (lat: number) => (maxY - mercY(lat)) * sy

  const { ctx, get } = makeCanvas(width, height)
  ctx.clearRect(0, 0, width, height)
  // 经纬度 bbox（用于索引）
  const toLon = (x: number) => x / (R * RAD)
  const toLat = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / RAD
  const wLon = toLon(minX)
  const eLon = toLon(maxX)
  const sLat = toLat(minY)
  const nLat = toLat(maxY)

  const all = ensure()
  let hits = 0

  for (const name of p.layers) {
    const layer = all.find((l) => l.meta.name === name)
    if (!layer) continue
    const style: StyleSpec = { ...layer.meta.style, ...(p.overrides?.[name] ?? {}) }
    const filter = p.cql?.[name] ? parseCql(p.cql[name]) : null
    const idxs = query(layer, wLon, sLat, eLon, nLat)
    ctx.globalAlpha = (p.opacity?.[name] ?? 1) * (style.opacity ?? 1)


    if (layer.meta.type === 'Point') {
      // 同色合并成一个 path：上万个点也只调用一次 fill
      const buckets = new Map<string, number[][]>()
      for (const i of idxs) {
        const f = layer.feats[i]
        if (filter && !filter(f.props)) continue
        const [lon, lat] = f.coords as number[]
        if (lon < wLon || lon > eLon || lat < sLat || lat > nLat) continue
        const color = rampColor(style.ramp, f.props, style.fill ?? '#8ef0b8')
        const arr = buckets.get(color)
        if (arr) arr.push([px(lon), py(lat)])
        else buckets.set(color, [[px(lon), py(lat)]])
        hits++
      }
      const r = style.radius ?? 2
      for (const [color, pts] of buckets) {
        ctx.fillStyle = color
        ctx.beginPath()
        for (const [x, y] of pts) {
          ctx.moveTo(x + r, y)
          ctx.arc(x, y, r, 0, Math.PI * 2)
        }
        ctx.fill()
      }
    } else if (layer.meta.type === 'LineString') {
      const buckets = new Map<string, number[][][]>()
      for (const i of idxs) {
        const f = layer.feats[i]
        if (filter && !filter(f.props)) continue
        const line = f.coords as number[][]
        const color = rampColor(style.ramp, f.props, style.stroke ?? '#7fd0ff')
        const arr = buckets.get(color)
        if (arr) arr.push(line)
        else buckets.set(color, [line])
        hits++
      }
      for (const [color, lines] of buckets) {
        ctx.strokeStyle = color
        ctx.lineWidth = style.width ?? 1.5
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        for (const line of lines) {
          line.forEach(([lon, lat], k) => {
            const x = px(lon)
            const y = py(lat)
            if (k === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
        }
        ctx.stroke()
      }
    } else {
      // 面：按颜色分组，同色一次性 fill + stroke
      const buckets = new Map<string, number[][][]>()
      for (const i of idxs) {
        const f = layer.feats[i]
        if (filter && !filter(f.props)) continue
        const ring = f.coords as number[][]
        const color = rampColor(style.ramp, f.props, style.fill ?? 'rgba(240,166,92,0.55)')
        const arr = buckets.get(color)
        if (arr) arr.push(ring)
        else buckets.set(color, [ring])
        hits++
      }
      for (const [color, rings] of buckets) {
        ctx.fillStyle = color
        ctx.beginPath()
        for (const ring of rings) {
          ring.forEach(([lon, lat], k) => {
            const x = px(lon)
            const y = py(lat)
            if (k === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
          ctx.closePath()
        }
        ctx.fill()
        if (style.stroke && (style.width ?? 0) > 0) {
          ctx.strokeStyle = style.stroke
          ctx.lineWidth = style.width!
          ctx.stroke()
        }
      }
    }
  }
  ctx.globalAlpha = 1

  const ms = performance.now() - t0
  const image = get()
  if (!p.silent) {
    record('GetMap', {
      layers: p.layers,
      ...(p.tile ? { z: p.tile[0], x: p.tile[1], y: p.tile[2] } : {}),
      ms,
      features: hits,
      url: buildUrl('GetMap', p),
    })
  }
  return { image, ms, features: hits }
}

/* ---------------------------- 请求 URL ---------------------------- */

/** 拼出标准 GeoServer 请求 URL（展示用，方便换成真实服务） */
export function buildUrl(op: RequestLog['op'], p: GetMapParams): string {
  const q = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: op,
    layers: p.layers.join(','),
    styles: '',
    crs: 'EPSG:3857',
    bbox: p.bbox.map((v) => v.toFixed(1)).join(','),
    width: String(p.width),
    height: String(p.height),
    format: 'image/png',
    transparent: 'true',
  })
  const cql = Object.entries(p.cql ?? {})
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `${k}:${v}`)
  if (cql.length) q.set('cql_filter', cql.join(';'))
  return `/geoserver/wms?${q.toString()}`
}

/* ---------------------------- WFS 查询 ---------------------------- */

export interface FeatureResult {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    id: number
    geometry: { type: GeomType; coordinates: unknown }
    properties: Props
  }>
  totalFeatures: number
  ms: number
}

/**
 * WFS GetFeature：按 bbox + CQL 返回 GeoJSON。
 * GeoServer 默认输出就是 GeoJSON（outputFormat=application/json）。
 */
export function getFeature(name: string, opts: { bbox?: [number, number, number, number]; cql?: string; count?: number } = {}): FeatureResult {
  const t0 = performance.now()
  const all = ensure()
  const layer = all.find((l) => l.meta.name === name)
  const out: FeatureResult['features'] = []
  if (!layer) return { type: 'FeatureCollection', features: out, totalFeatures: 0, ms: 0 }

  let idxs: number[]
  if (opts.bbox) {
    const [minX, minY, maxX, maxY] = opts.bbox
    const toLon = (x: number) => x / (R * RAD)
    const toLat = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / RAD
    idxs = query(layer, toLon(minX), toLat(minY), toLon(maxX), toLat(maxY))
  } else {
    idxs = layer.feats.map((_, i) => i)
  }
  const filter = opts.cql ? parseCql(opts.cql) : null
  const cap = opts.count ?? 2000
  let total = 0
  for (const i of idxs) {
    const f = layer.feats[i]
    if (filter && !filter(f.props)) continue
    total++
    if (out.length >= cap) continue
    out.push({
      type: 'Feature',
      id: f.id,
      // GeoJSON 的 Polygon 是 [ring]，内部存的是单环 → 输出时必须补一层，
      // 否则 ol/format/GeoJSON 会把它当 LineString 读，WFS 前端直接错位
      geometry: { type: f.geom, coordinates: f.geom === 'Polygon' ? [f.coords] : f.coords },
      properties: f.props,
    })
  }
  const ms = performance.now() - t0
  record('GetFeature', {
    layers: [name],
    ms,
    features: total,
    url: `/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=${name}&outputFormat=application/json`,
  })
  return { type: 'FeatureCollection', features: out, totalFeatures: total, ms }
}

/* -------------------------- GetFeatureInfo -------------------------- */

export interface FeatureInfoResult {
  hits: Array<{ layer: string; id: number; properties: Props }>
  ms: number
}

/**
 * WMS GetFeatureInfo：给像素坐标与 BBOX，返回该处要素。
 * 点图层按像素距离判定，线/面用包围盒近似（示例够用）。
 */
export function getFeatureInfo(
  p: GetMapParams & { i: number; j: number },
): FeatureInfoResult {
  const t0 = performance.now()
  const [minX, minY, maxX, maxY] = p.bbox
  const sx = p.width / (maxX - minX)
  const sy = p.height / (maxY - minY)
  // 像素 → 经纬度
  const lon = (minX + p.i / sx) / (R * RAD)
  const lat = (2 * Math.atan(Math.exp((maxY - p.j / sy) / R)) - Math.PI / 2) / RAD
  const tol = 6 / sx // 6 像素容差（米）

  const all = ensure()
  const hits: FeatureInfoResult['hits'] = []
  for (const name of p.layers) {
    const layer = all.find((l) => l.meta.name === name)
    if (!layer) continue
    const filter = p.cql?.[name] ? parseCql(p.cql[name]) : null
    let best: { d: number; id: number; props: Props } | null = null
    for (const f of layer.feats) {
      if (filter && !filter(f.props)) continue
      const [w, s, e, n] = f.bbox
      if (lon < w - tol || lon > e + tol || lat < s - tol || lat > n + tol) continue
      let d = Infinity
      if (f.geom === 'Point') {
        const [flon, flat] = f.coords as number[]
        d = Math.hypot(mercX(flon) - mercX(lon), mercY(flat) - mercY(lat))
      } else {
        d = 0 // 线/面：命中即取（后出现的优先）
      }
      if (!best || d <= best.d) best = { d, id: f.id, props: f.props }
    }
    if (best) hits.push({ layer: name, id: best.id, properties: best.props })
  }
  const ms = performance.now() - t0
  record('GetFeatureInfo', {
    layers: p.layers,
    ms,
    features: hits.length,
    url: `/geoserver/wms?request=GetFeatureInfo&query_layers=${p.layers.join(',')}&i=${Math.round(p.i)}&j=${Math.round(p.j)}`,
  })
  return { hits, ms }
}

/* -------------------------- GetCapabilities -------------------------- */

/** 生成 WMS 1.3.0 能力文档（裁剪版，保留 GeoServer 的关键结构） */
export function getCapabilities(baseUrl = '/geoserver/wms'): string {
  const all = ensure()
  const fmt = (l: LayerData) =>
    `      <Layer queryable="1">
        <Name>${l.meta.name}</Name>
        <Title>${l.meta.title}</Title>
        <CRS>EPSG:3857</CRS>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>${EXTENT.w}</westBoundLongitude>
          <eastBoundLongitude>${EXTENT.e}</eastBoundLongitude>
          <southBoundLatitude>${EXTENT.s}</southBoundLatitude>
          <northBoundLatitude>${EXTENT.n}</northBoundLatitude>
        </EX_GeographicBoundingBox>
        <Style><Name>default</Name><Title>${l.meta.type} Style</Title></Style>
      </Layer>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service>
    <Name>WMS</Name>
    <Title>${SERVICE_TITLE}</Title>
    <Abstract>浏览器内 OGC 服务：参数与 GeoServer 一致，可在离线环境演示 WMS/WFS 全链路</Abstract>
  </Service>
  <Capability>
    <Request>
      <GetCapabilities><Format>text/xml</Format></GetCapabilities>
      <GetMap><Format>image/png</Format></GetMap>
      <GetFeatureInfo><Format>application/json</Format></GetFeatureInfo>
    </Request>
    <Exception><Format>XML</Format></Exception>
    <Layer>
      <Title>${SERVICE_TITLE}</Title>
      <CRS>EPSG:3857</CRS>
${all.map(fmt).join('\n')}
    </Layer>
  </Capability>
</WMS_Capabilities>`
}

/* ---------------------------- WFS-T 事务 ---------------------------- */

/** 外部 GeoJSON 几何 → 内部坐标（面拆出外环）+ 经纬度 bbox */
function unwrapGeometry(g: { type: GeomType; coordinates: unknown }): {
  coords: Coords
  bbox: [number, number, number, number]
} {
  if (g.type === 'Point') {
    const [x, y] = g.coordinates as number[]
    return { coords: [x, y], bbox: [x, y, x, y] }
  }
  if (g.type === 'Polygon') {
    const ring = ((g.coordinates as number[][][])[0] ?? []) as number[][]
    return { coords: ring, bbox: ringBBox(ring) }
  }
  const line = g.coordinates as number[][]
  return { coords: line, bbox: ringBBox(line) }
}

type Coords = number[] | number[][] | number[][][]

export interface FeaturePayload {
  geometry?: { type: GeomType; coordinates: unknown }
  properties?: Props
}

export interface TransactionOp {
  action: 'insert' | 'update' | 'delete'
  layer: string
  /** update / delete 按要素 id 定位 */
  id?: number
  feature?: FeaturePayload
}

export interface TransactionResult {
  ok: boolean
  inserted: number
  updated: number
  deleted: number
  ms: number
  message: string
  /** 受影响图层的当前要素数 */
  count: number
}

/**
 * WFS-T（Transaction）：对服务端数据做增删改。
 *
 * 这是 WFS 与 WMS 的根本区别 —— WMS 只能出图，WFS 能把要素取下来改完再写回去。
 * 真实 GeoServer 要 POST 一段 wfs:Transaction XML；这里用对象数组表达同样的语义，
 * 改完立即重建空间索引，并让 WMTS 切片缓存失效（否则地图上还是旧瓦片）。
 */
export function transaction(ops: TransactionOp[]): TransactionResult {
  const t0 = performance.now()
  let inserted = 0
  let updated = 0
  let deleted = 0
  const touched = new Set<LayerData>()
  let lastCount = 0

  for (const op of ops) {
    const layer = ensure().find((l) => l.meta.name === op.layer)
    if (!layer) continue
    lastCount = layer.feats.length

    if (op.action === 'insert' && op.feature?.geometry) {
      const g = op.feature.geometry
      const { coords, bbox } = unwrapGeometry(g)
      layer.seq += 1
      layer.feats.push({
        id: layer.seq,
        geom: g.type,
        coords,
        bbox,
        props: { ...(op.feature.properties ?? {}) },
      })
      inserted++
      touched.add(layer)
    } else if (op.action === 'update' && op.id != null) {
      const f = layer.feats.find((x) => x.id === op.id)
      if (!f) continue
      if (op.feature?.geometry) {
        const { coords, bbox } = unwrapGeometry(op.feature.geometry)
        f.geom = op.feature.geometry.type
        f.coords = coords
        f.bbox = bbox
      }
      if (op.feature?.properties) f.props = { ...f.props, ...op.feature.properties }
      updated++
      touched.add(layer)
    } else if (op.action === 'delete' && op.id != null) {
      const i = layer.feats.findIndex((x) => x.id === op.id)
      if (i < 0) continue
      layer.feats.splice(i, 1)
      deleted++
      touched.add(layer)
    }
    lastCount = layer.feats.length
  }

  // 要素变了：空间索引重建、切片缓存作废
  for (const l of touched) l.index = buildIndex(l.feats)
  if (touched.size) tileCache.clear()

  const ms = performance.now() - t0
  record('Transaction', {
    layers: Array.from(touched).map((l) => l.meta.name),
    ms,
    features: inserted + updated + deleted,
    url: '/geoserver/wfs?service=WFS&version=2.0.0&request=Transaction',
  })
  return {
    ok: touched.size > 0,
    inserted,
    updated,
    deleted,
    ms,
    message: touched.size ? `insert ${inserted} / update ${updated} / delete ${deleted}` : '无匹配要素',
    count: lastCount,
  }
}

/** WFS DescribeFeatureType：字段清单（XSD 片段） */
export function describeFeatureType(name: string): string {
  const layer = ensure().find((l) => l.meta.name === name)
  if (!layer) return ''
  const geomType =
    layer.meta.type === 'Point'
      ? 'gml:PointPropertyType'
      : layer.meta.type === 'LineString'
        ? 'gml:MultiLineStringPropertyType'
        : 'gml:MultiSurfacePropertyType'
  const fields = layer.meta.fields
    .map(
      (f) =>
        `      <xsd:element name="${f.name}" minOccurs="0" maxOccurs="1" type="${
          f.type === 'number' ? 'xsd:double' : 'xsd:string'
        }"/>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2"
            xmlns:city="http://vizforge.local/city" elementFormDefault="qualified"
            targetNamespace="http://vizforge.local/city">
  <xsd:import namespace="http://www.opengis.net/gml/3.2"/>
  <xsd:complexType name="${name.split(':')[1]}Type">
    <xsd:complexContent>
      <xsd:extension base="gml:AbstractFeatureType">
        <xsd:sequence>
          <xsd:element name="geom" minOccurs="0" maxOccurs="1" type="${geomType}"/>
${fields}
        </xsd:sequence>
      </xsd:extension>
    </xsd:complexContent>
  </xsd:complexType>
  <xsd:element name="${name.split(':')[1]}" type="city:${name.split(':')[1]}Type" substitutionGroup="gml:AbstractFeature"/>
</xsd:schema>`
}

/* ------------------------------ WMTS ------------------------------ */

/**
 * 切片缓存：模拟 GeoServer 的 GeoWebCache。
 *
 * 命中直接返回已渲染的瓦片（亚毫秒），未命中才走一次 GetMap 渲染。
 * 「命中率」就是切片服务存在的理由 —— 这也解释了为什么底图用 WMTS 而不是 WMS。
 */
const tileCache = new Map<string, ImageData>()
const TILE_CACHE_MAX = 200

let cacheHits = 0
let cacheMisses = 0
let lastTileMs = 0
let lastTileCached = false

export interface TileCacheStats {
  hits: number
  misses: number
  size: number
  hitRate: number
  lastMs: number
  lastCached: boolean
}

export function getTileCacheStats(): TileCacheStats {
  const total = cacheHits + cacheMisses
  return {
    hits: cacheHits,
    misses: cacheMisses,
    size: tileCache.size,
    hitRate: total ? cacheHits / total : 0,
    lastMs: lastTileMs,
    lastCached: lastTileCached,
  }
}

export function clearTileCache(): void {
  tileCache.clear()
  cacheHits = 0
  cacheMisses = 0
  lastTileMs = 0
  lastTileCached = false
}

export interface TileResult {
  image: ImageData
  cached: boolean
  ms: number
}

/** WMTS GetTile：加一层切片缓存，语义上等价 GeoServer 的 gwc/service/wmts */
export function wmtsTile(
  layerNames: string[],
  z: number,
  x: number,
  y: number,
  cql?: Record<string, string>,
): TileResult {
  const t0 = performance.now()
  const key = `${layerNames.join('+')}|${z}/${x}/${y}|${cql ? JSON.stringify(cql) : ''}`
  const hit = tileCache.get(key)
  if (hit) {
    cacheHits++
    lastTileMs = performance.now() - t0
    lastTileCached = true
    return { image: hit, cached: true, ms: lastTileMs }
  }

  cacheMisses++
  const span = WORLD / Math.pow(2, z)
  const minX = -WORLD / 2 + x * span
  const maxY = WORLD / 2 - y * span
  const { image } = getMap({
    layers: layerNames,
    bbox: [minX, maxY - span, minX + span, maxY],
    width: 256,
    height: 256,
    cql,
    silent: true,
  })

  // 简单 FIFO 淘汰，控制内存（一张 256² RGBA ≈ 256KB）
  if (tileCache.size >= TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value
    if (oldest) tileCache.delete(oldest)
  }
  tileCache.set(key, image)

  lastTileMs = performance.now() - t0
  lastTileCached = false
  record('GetTile', {
    layers: layerNames,
    z,
    x,
    y,
    ms: lastTileMs,
    features: 0,
    url: `/geoserver/gwc/service/wmts?service=WMTS&request=GetTile&layer=${layerNames.join(
      ',',
    )}&tilematrix=EPSG:3857:${z}&tilerow=${y}&tilecol=${x}&format=image/png`,
  })
  return { image, cached: false, ms: lastTileMs }
}
