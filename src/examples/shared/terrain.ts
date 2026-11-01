/* ============================================================
 * 程序化 DEM（数字高程模型）—— 地形类示例共用
 *
 * 为什么自己造高程而不是接真实地形服务：
 *  1) 离线可跑，不依赖 ion token / 第三方高程瓦片，示例在任何网络环境下都一致；
 *  2) 真值已知，挖方量、淹没水量、可视率这些统计量可以对拍验证；
 *  3) 形状可控（山脊 / 河谷 / 缓丘），每个示例都能拿到最适合的地形。
 *
 * 提供的能力：
 *  - makeDEM      分形噪声合成高程场（value noise + fBm + ridged 脊化 + 河谷刻蚀 + 闭合洼地）
 *  - sampleH      双线性插值取任意 uv（0..1）处高程
 *  - slopeAt      中心差分算坡度 / 坡向（用真实米制格网边长，不是格网索引）
 *  - hillshade    Horn 算法的山体阴影（太阳方位角 / 高度角 / 垂直夸张）
 *  - contours     Marching Squares 追踪等高线，返回 uv 空间的线段
 *  - makeRamp     把色带停靠点烘成 0..1 → RGB 的函数
 * ============================================================ */

export interface DEM {
  /** 网格边长格数（n × n） */
  n: number
  /** 高程数组，row-major，第 0 行是北边（lat1） */
  h: Float32Array
  /** 格网边长（米） */
  cell: number
  min: number
  max: number
  lon0: number
  lat0: number
  lon1: number
  lat1: number
}

/* ---------------- 噪声 ---------------- */

/** 32 位整数散列 → [0,1)，固定种子保证每次打开地形一致 */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const fade = (t: number) => t * t * (3 - 2 * t)

/** 二维 value noise：整数格点取值后做平滑插值 */
function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = fade(x - xi)
  const yf = fade(y - yi)
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf
}

/** fBm：多个倍频叠加，每一层振幅减半、频率翻倍 */
function fbm(x: number, y: number, seed: number, oct: number, gain = 0.5, lac = 2.03): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let fx = x
  let fy = y
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(fx, fy, seed + i * 131)
    norm += amp
    amp *= gain
    fx *= lac
    fy *= lac
  }
  return sum / norm
}

/** ridged：把 fBm 折成"脊线"，|2n-1| 取反后自乘，得到尖锐山脊而不是圆滚滚的丘 */
function ridged(x: number, y: number, seed: number, oct: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let fx = x
  let fy = y
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(2 * noise2(fx, fy, seed + i * 977) - 1)
    sum += amp * n * n
    norm += amp
    amp *= 0.5
    fx *= 2.07
    fy *= 2.07
  }
  return sum / norm
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

export type DemShape = 'mountain' | 'valley' | 'rolling'

export interface DemOpts {
  /** 中心经纬度 */
  lon: number
  lat: number
  /** 区域边长（米），正方形 */
  span: number
  /** 网格分辨率，默认 129（含边界共 129×129 个高程点） */
  n?: number
  /** 最大高差（米） */
  relief?: number
  /** 最低高程（米），默认 0 */
  base?: number
  seed?: number
  shape?: DemShape
  octaves?: number
}

/**
 * 生成 DEM。
 * 归一化流程：先合成 0..1 的相对起伏 → 再线性拉伸到 [base, base+relief]，
 * 这样不同形状的高差都可控，统计量（挖方、水量）才有可比性。
 */
export function makeDEM(o: DemOpts): DEM {
  const n = o.n ?? 129
  const relief = o.relief ?? 600
  const base = o.base ?? 0
  const seed = o.seed ?? 20260101
  const shape = o.shape ?? 'mountain'
  const oct = o.octaves ?? 6
  const cell = o.span / (n - 1)

  // 经纬度跨度：纬度按 1° ≈ 110540m，经度要除 cos(lat)
  const dLat = o.span / 110540
  const dLon = o.span / (111320 * Math.cos((o.lat * Math.PI) / 180))
  const lat0 = o.lat - dLat / 2
  const lat1 = o.lat + dLat / 2
  const lon0 = o.lon - dLon / 2
  const lon1 = o.lon + dLon / 2

  const raw = new Float32Array(n * n)

  // 河谷中心线：一条蜿蜒的正弦曲线（v 随 u 摆动）
  const channelV = (u: number) =>
    0.5 + 0.13 * Math.sin(u * Math.PI * 2 * 1.2 + 0.7) + 0.05 * Math.sin(u * Math.PI * 2 * 3.1 + 2.1)

  // 闭合洼地（山后洼地）：中心 + 半径 + 深度，外围带一圈 rim 保证"闭合"
  const basins: Array<[number, number, number, number]> = [
    [0.24, 0.3, 0.075, 0.3],
    [0.76, 0.7, 0.062, 0.26],
  ]

  for (let j = 0; j < n; j++) {
    const v = j / (n - 1)
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1)
      const nx = u * 3.2
      const ny = v * 3.2
      let hgt: number

      if (shape === 'rolling') {
        // 缓丘：普通 fBm 打底，再叠一层低频起伏，整体压平便于土方计算
        hgt = 0.62 * fbm(nx, ny, seed, 4) + 0.38 * fbm(nx * 0.45, ny * 0.45, seed + 71, 3)
        hgt = 0.25 + 0.6 * clamp01(hgt)
      } else if (shape === 'valley') {
        // 河谷：两侧山脊 + 中间河道刻蚀 + 山后闭合洼地
        const ridge = smoothstep(0.16, 0.52, Math.abs(v - 0.5))
        const mountains = ridged(nx * 1.15, ny * 1.15, seed, oct)
        hgt = 0.22 + 0.78 * ridge * mountains + 0.16 * fbm(nx * 2.4, ny * 2.4, seed + 33, 4)
        // 河道刻蚀：距中心线越近挖得越深
        const d = Math.abs(v - channelV(u))
        hgt -= 0.4 * Math.exp(-((d / 0.05) * (d / 0.05)))
      } else {
        // 山地：ridged 为主，掺一点 fBm 避免过于规整
        hgt = 0.78 * ridged(nx, ny, seed, oct) + 0.22 * fbm(nx * 1.8, ny * 1.8, seed + 17, 4)
        // 四周略降，让整块地形像一座山体而不是切平的方块
        const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2
        hgt *= 1 - 0.25 * smoothstep(0.7, 1, edge)
        hgt = 0.08 + 0.92 * clamp01(hgt)
      }

      if (shape === 'valley') {
        for (const [bu, bv, br, bd] of basins) {
          const dx = u - bu
          const dy = (v - bv) * 1.0
          const r = Math.sqrt(dx * dx + dy * dy)
          // 中心下凹
          hgt -= bd * Math.exp(-((r / br) * (r / br)) * 2.2)
          // 外围 rim 抬升，保证洼地是"闭合"的（连通性淹没时不会被河水灌入）
          hgt += 0.16 * Math.exp(-(((r - br * 1.9) / (br * 0.7)) ** 2))
        }
      }

      raw[j * n + i] = clamp01(hgt)
    }
  }

  // 拉伸到真实米制
  const h = new Float32Array(n * n)
  let min = Infinity
  let max = -Infinity
  for (let k = 0; k < h.length; k++) {
    const v = base + raw[k] * relief
    h[k] = v
    if (v < min) min = v
    if (v > max) max = v
  }

  return { n, h, cell, min, max, lon0, lat0, lon1, lat1 }
}

/* ---------------- 采样 ---------------- */

/** uv（0..1，u 向东、v 向南）→ 经纬度 */
export function uvToLonLat(dem: DEM, u: number, v: number): [number, number] {
  return [dem.lon0 + (dem.lon1 - dem.lon0) * u, dem.lat1 - (dem.lat1 - dem.lat0) * v]
}

/** 经纬度 → uv（可能落在 [0,1] 之外，调用方自行判断） */
export function lonLatToUV(dem: DEM, lon: number, lat: number): [number, number] {
  return [
    (lon - dem.lon0) / (dem.lon1 - dem.lon0),
    (dem.lat1 - lat) / (dem.lat1 - dem.lat0),
  ]
}

/** 双线性插值取高程（越界按边缘夹取） */
export function sampleH(dem: DEM, u: number, v: number): number {
  const n = dem.n
  const x = clamp01(u) * (n - 1)
  const y = clamp01(v) * (n - 1)
  const i0 = Math.floor(x)
  const j0 = Math.floor(y)
  const i1 = Math.min(i0 + 1, n - 1)
  const j1 = Math.min(j0 + 1, n - 1)
  const fx = x - i0
  const fy = y - j0
  const h = dem.h
  const a = h[j0 * n + i0]
  const b = h[j0 * n + i1]
  const c = h[j1 * n + i0]
  const d = h[j1 * n + i1]
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
}

/** 坡度（度）与坡向（度，正北为 0，顺时针） */
export function slopeAt(dem: DEM, u: number, v: number): { slope: number; aspect: number } {
  const d = dem.cell
  const hx = sampleH(dem, u + 1 / (dem.n - 1), v) - sampleH(dem, u - 1 / (dem.n - 1), v)
  const hy = sampleH(dem, u, v + 1 / (dem.n - 1)) - sampleH(dem, u, v - 1 / (dem.n - 1))
  const dzdx = hx / (2 * d)
  const dzdy = -hy / (2 * d) // v 向南为正，转换成"北为正"
  const slope = Math.atan(Math.hypot(dzdx, dzdy))
  let aspect = Math.atan2(dzdx, -dzdy) // 0 = 北，顺时针
  if (aspect < 0) aspect += Math.PI * 2
  return { slope: (slope * 180) / Math.PI, aspect: (aspect * 180) / Math.PI }
}

/* ---------------- 山体阴影 ---------------- */

/**
 * Horn 算法山体阴影：3×3 窗口算坡面法向，再与太阳方向做点积。
 * 返回值 0..1（0 = 完全背光）。
 */
export function hillshade(dem: DEM, azDeg: number, altDeg: number, zf = 1): Float32Array {
  const n = dem.n
  const out = new Float32Array(n * n)
  const cell = dem.cell
  const az = ((azDeg - 90) * Math.PI) / 180 // GIS 方位角（北 0 顺时针）→ 数学角
  const alt = (altDeg * Math.PI) / 180
  const sinAlt = Math.sin(alt)
  const cosAlt = Math.cos(alt)
  for (let j = 0; j < n; j++) {
    const jm = j > 0 ? j - 1 : 0
    const jp = j < n - 1 ? j + 1 : n - 1
    for (let i = 0; i < n; i++) {
      const im = i > 0 ? i - 1 : 0
      const ip = i < n - 1 ? i + 1 : n - 1
      const a = dem.h[jm * n + im]
      const b = dem.h[jm * n + i]
      const c = dem.h[jm * n + ip]
      const d = dem.h[j * n + im]
      const f = dem.h[j * n + ip]
      const g = dem.h[jp * n + im]
      const hh = dem.h[jp * n + i]
      const ii = dem.h[jp * n + ip]
      const dzdx = ((c + 2 * f + ii) - (a + 2 * d + g)) / (8 * cell)
      const dzdy = ((g + 2 * hh + ii) - (a + 2 * b + c)) / (8 * cell)
      const sl = Math.atan(zf * Math.hypot(dzdx, dzdy))
      const asp = Math.atan2(dzdy, -dzdx)
      const v = cosAlt * Math.cos(sl) + sinAlt * Math.sin(sl) * Math.cos(az - asp)
      out[j * n + i] = clamp01(v * 1.05)
    }
  }
  return out
}

/* ---------------- 等高线（Marching Squares） ---------------- */

/**
 * 追踪某一条等高线，返回 uv 空间的线段数组 [u1,v1,u2,v2]。
 * 16 种情形用查表法处理；鞍点（case 5 / 10）用中心值消歧，避免出现断口。
 */
export function contourLine(dem: DEM, level: number): number[] {
  const n = dem.n
  const segs: number[] = []
  const du = 1 / (n - 1)
  const dv = 1 / (n - 1)
  const lerp = (a: number, b: number) => (level - a) / (b - a || 1e-9)

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = dem.h[j * n + i] // 左上
      const b = dem.h[j * n + i + 1] // 右上
      const c = dem.h[(j + 1) * n + i + 1] // 右下
      const d = dem.h[(j + 1) * n + i] // 左下
      let code = 0
      if (a > level) code |= 8
      if (b > level) code |= 4
      if (c > level) code |= 2
      if (d > level) code |= 1
      if (code === 0 || code === 15) continue

      const u0 = i * du
      const v0 = j * dv
      // 四条边上的交点
      const top = () => [u0 + du * lerp(a, b), v0]
      const right = () => [u0 + du, v0 + dv * lerp(b, c)]
      const bottom = () => [u0 + du * lerp(d, c), v0 + dv]
      const left = () => [u0, v0 + dv * lerp(a, d)]
      const push = (p1: number[], p2: number[]) => segs.push(p1[0], p1[1], p2[0], p2[1])

      switch (code) {
        case 1:
        case 14:
          push(left(), bottom())
          break
        case 2:
        case 13:
          push(bottom(), right())
          break
        case 3:
        case 12:
          push(left(), right())
          break
        case 4:
        case 11:
          push(top(), right())
          break
        case 6:
        case 9:
          push(top(), bottom())
          break
        case 7:
        case 8:
          push(left(), top())
          break
        case 5: {
          // 鞍点：用中心值决定连线方式
          const center = (a + b + c + d) / 4
          if (center > level) {
            push(left(), top())
            push(bottom(), right())
          } else {
            push(left(), bottom())
            push(top(), right())
          }
          break
        }
        case 10: {
          const center = (a + b + c + d) / 4
          if (center > level) {
            push(top(), right())
            push(left(), bottom())
          } else {
            push(top(), left())
            push(right(), bottom())
          }
          break
        }
      }
    }
  }
  return segs
}

/**
 * 通用 Marching Squares：对任意 n×n 标量场提取等值线段。
 * 返回 [x1,y1,x2,y2, ...]，坐标为格网索引（0..n-1）。
 * 等时圈、降雨等值线等"非高程场"的等值线都用它。
 */
export function marchingSquares(field: Float32Array, n: number, level: number): number[] {
  const segs: number[] = []
  const lerp = (a: number, b: number) => (level - a) / (b - a || 1e-9)
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = field[j * n + i]
      const b = field[j * n + i + 1]
      const c = field[(j + 1) * n + i + 1]
      const d = field[(j + 1) * n + i]
      let code = 0
      if (a < level) code |= 8
      if (b < level) code |= 4
      if (c < level) code |= 2
      if (d < level) code |= 1
      if (code === 0 || code === 15) continue
      const top = () => [i + lerp(a, b), j]
      const right = () => [i + 1, j + lerp(b, c)]
      const bottom = () => [i + lerp(d, c), j + 1]
      const left = () => [i, j + lerp(a, d)]
      const push = (p1: number[], p2: number[]) => segs.push(p1[0], p1[1], p2[0], p2[1])
      switch (code) {
        case 1:
        case 14:
          push(left(), bottom())
          break
        case 2:
        case 13:
          push(bottom(), right())
          break
        case 3:
        case 12:
          push(left(), right())
          break
        case 4:
        case 11:
          push(top(), right())
          break
        case 6:
        case 9:
          push(top(), bottom())
          break
        case 7:
        case 8:
          push(left(), top())
          break
        case 5:
        case 10: {
          const center = (a + b + c + d) / 4
          if ((center < level) === (code === 5)) {
            push(left(), top())
            push(bottom(), right())
          } else {
            push(left(), bottom())
            push(top(), right())
          }
        }
      }
    }
  }
  return segs
}

/* ---------------- 色带 ---------------- */
export type Ramp = (t: number) => [number, number, number]

/** 把 [位置, '#rrggbb'] 停靠点烘成 0..1 → RGB 的插值函数 */
export function makeRamp(stops: Array<[number, string]>): Ramp {
  const pts = stops.map(([at, hex]) => {
    const v = parseInt(hex.slice(1), 16)
    return { at, r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
  })
  return (t: number) => {
    const x = clamp01(t)
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]
      const q = pts[i + 1]
      if (x <= q.at) {
        const k = q.at === p.at ? 0 : (x - p.at) / (q.at - p.at)
        return [p.r + (q.r - p.r) * k, p.g + (q.g - p.g) * k, p.b + (q.b - p.b) * k]
      }
    }
    const last = pts[pts.length - 1]
    return [last.r, last.g, last.b]
  }
}

/** 标准高程分层设色（海洋→平原→丘陵→高山→雪线） */
export const HYPSOMETRIC = makeRamp([
  [0.0, '#1d4e6b'],
  [0.12, '#3f7d52'],
  [0.3, '#8fae52'],
  [0.48, '#d6c47a'],
  [0.68, '#b07f4b'],
  [0.85, '#8d6a5a'],
  [1.0, '#f2f4f7'],
])

/** 坡度色带（绿=平缓 → 黄 → 红=陡峭） */
export const SLOPE_RAMP = makeRamp([
  [0, '#4fd18b'],
  [0.25, '#a8dd5a'],
  [0.45, '#f2d24b'],
  [0.65, '#f08a3c'],
  [0.82, '#e2452f'],
  [1, '#8f1414'],
])

/* ---------------- 真实地形贴合 ---------------- */

/**
 * 用真实地形高程替换 DEM 的高程场（双线性重采样到 DEM 网格）。
 *
 * 用途：让分析（挖填方 / 淹没 / 可视域）跑在**真实地面**上，
 * 渲染时再把结果贴回地形，这样分析面与三维地形天然贴合，放大缩小都不会分离。
 * @param src 真实高程，n×n，row-major，第 0 行是北边
 * @param srcN 采样网格边数
 */
export function applyRealHeights(dem: DEM, src: Float32Array, srcN: number): void {
  const gain = (srcN - 1) / (dem.n - 1)
  let min = Infinity
  let max = -Infinity
  for (let j = 0; j < dem.n; j++) {
    const sy = Math.min(j * gain, srcN - 1.0001)
    const j0 = Math.floor(sy)
    const ty = sy - j0
    for (let i = 0; i < dem.n; i++) {
      const sx = Math.min(i * gain, srcN - 1.0001)
      const i0 = Math.floor(sx)
      const tx = sx - i0
      const a = src[j0 * srcN + i0]
      const b = src[j0 * srcN + i0 + 1]
      const c = src[(j0 + 1) * srcN + i0]
      const d = src[(j0 + 1) * srcN + i0 + 1]
      const h = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
      dem.h[j * dem.n + i] = h
      if (h < min) min = h
      if (h > max) max = h
    }
  }
  dem.min = min
  dem.max = max
}
