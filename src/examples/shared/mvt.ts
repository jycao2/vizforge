/**
 * 手写 Mapbox Vector Tile（MVT 2.1）编码器。
 *
 * 只依赖 protobuf 的 wire format 本身，不引 pbf / vt-pbf 之类的库：
 *   - 每个字段 = tag（field_no << 3 | wire_type）+ 值
 *   - 变长整数用 base-128，几何坐标先做 zigzag（有符号 → 无符号）
 *   - 嵌套结构（message）写成「tag + 长度 + 子字节流」
 *
 * 几何命令同样是「命令整数 + 参数」：
 *   命令整数 = (command_id & 0x7) | (count << 3)
 *   MoveTo=1 / LineTo=2 / ClosePath=7，坐标一律用相对上一点的 zigzag 增量。
 *
 * 瓦片坐标系原点在左上角、y 向下，范围 [0, extent]（extent 默认 4096）。
 */

export interface MvtPoint {
  type: 1
  coords: [number, number]
}

export interface MvtLine {
  type: 2
  coords: Array<[number, number]>
}

/** 环必须自己首尾不重复（ClosePath 指令会补上闭合点）；外环按顺时针（y 向下） */
export interface MvtPolygon {
  type: 3
  rings: Array<Array<[number, number]>>
}

export type MvtGeometry = MvtPoint | MvtLine | MvtPolygon

export interface MvtFeature {
  id: number
  geometry: MvtGeometry
  tags: Record<string, string | number | boolean>
}

export interface MvtLayer {
  name: string
  features: MvtFeature[]
  extent?: number
}

const wire = { varint: 0, fixed64: 1, bytes: 2 }

class Writer {
  private buf: number[] = []

  get size(): number {
    return this.buf.length
  }

  varint(v: number) {
    // protobuf 的 varint 是 7 位一组、低位在前，最高位表示「还有后续」
    let n = Math.max(0, Math.round(v))
    while (n >= 0x80) {
      this.buf.push((n & 0x7f) | 0x80)
      n = Math.floor(n / 128)
    }
    this.buf.push(n & 0x7f)
  }

  /** zigzag：把 -1 映射到 1、1 映射到 2，负数才不用写 10 字节 */
  sint(v: number) {
    this.varint(((v << 1) ^ (v >> 31)) >>> 0)
  }

  sintField(field: number, v: number) {
    this.tag(field, wire.varint)
    this.sint(v)
  }

  tag(field: number, type: number) {
    this.varint((field << 3) | type)
  }

  uint(field: number, v: number) {
    this.tag(field, wire.varint)
    this.varint(v)
  }

  str(field: number, s: string) {
    const bytes = new TextEncoder().encode(s)
    this.tag(field, wire.bytes)
    this.varint(bytes.length)
    for (const b of bytes) this.buf.push(b)
  }

  /** packed 重复字段：把所有值拼成一段字节流，整体再算一次长度 */
  packed(field: number, values: number[]) {
    this.tag(field, wire.bytes)
    const sub = new Writer()
    for (const v of values) sub.varint(v)
    this.varint(sub.size)
    this.buf.push(...sub.buf)
  }

  double(field: number, v: number) {
    this.tag(field, wire.fixed64)
    const dv = new DataView(new ArrayBuffer(8))
    dv.setFloat64(0, v, true)
    for (let i = 0; i < 8; i++) this.buf.push(dv.getUint8(i))
  }

  message(field: number, build: (w: Writer) => void) {
    const sub = new Writer()
    build(sub)
    this.messageBytes(field, sub.toBytes())
  }

  /** 直接塞一段已经编好的消息体（tag + 长度 + 字节） */
  messageBytes(field: number, bytes: Uint8Array) {
    this.tag(field, wire.bytes)
    this.varint(bytes.length)
    for (const b of bytes) this.buf.push(b)
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.buf)
  }
}

const MOVE_TO = 1
const LINE_TO = 2
const CLOSE_PATH = 7

function cmd(id: number, count: number): number {
  return (id & 0x7) | (count << 3)
}

function encodeGeometry(g: MvtGeometry): number[] {
  const out: number[] = []
  const r = Math.round

  if (g.type === 1) {
    out.push(cmd(MOVE_TO, 1), zz(r(g.coords[0])), zz(r(g.coords[1])))
    return out
  }

  if (g.type === 2) {
    const pts = g.coords
    if (pts.length < 2) return out
    let px = r(pts[0][0])
    let py = r(pts[0][1])
    out.push(cmd(MOVE_TO, 1), zz(px), zz(py))
    out.push(cmd(LINE_TO, pts.length - 1))
    for (let i = 1; i < pts.length; i++) {
      const x = r(pts[i][0])
      const y = r(pts[i][1])
      out.push(zz(x - px), zz(y - py))
      px = x
      py = y
    }
    return out
  }

  for (const ring of g.rings) {
    if (ring.length < 3) continue
    const pts = ring.map(([x, y]) => [r(x), r(y)] as [number, number])
    // 首尾点重合的话去掉，闭合交给 ClosePath，否则会多画一段零长度线
    if (pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
      pts.pop()
    }
    let px = pts[0][0]
    let py = pts[0][1]
    out.push(cmd(MOVE_TO, 1), zz(px), zz(py))
    out.push(cmd(LINE_TO, pts.length - 1))
    for (let i = 1; i < pts.length; i++) {
      out.push(zz(pts[i][0] - px), zz(pts[i][1] - py))
      px = pts[i][0]
      py = pts[i][1]
    }
    out.push(cmd(CLOSE_PATH, 1))
  }
  return out
}

function zz(n: number): number {
  return ((n << 1) ^ (n >> 31)) >>> 0
}

function writeLayer(layer: MvtLayer): Writer {
  const keys: string[] = []
  const values: Array<string | number | boolean> = []
  const keyIdx = new Map<string, number>()
  const valIdx = new Map<string, number>()

  const rows = layer.features.map((f) => {
    const tags: number[] = []
    for (const key of Object.keys(f.tags)) {
      const v = f.tags[key]
      let ki = keyIdx.get(key)
      if (ki === undefined) {
        ki = keys.length
        keys.push(key)
        keyIdx.set(key, ki)
      }
      const vk = `${typeof v}:${String(v)}`
      let vi = valIdx.get(vk)
      if (vi === undefined) {
        vi = values.length
        values.push(v)
        valIdx.set(vk, vi)
      }
      tags.push(ki, vi)
    }
    return { id: f.id, geom: encodeGeometry(f.geometry), type: f.geometry.type, tags }
  })

  const w = new Writer()
  w.uint(15, 2) // version = 2
  w.str(1, layer.name)
  for (const row of rows) {
    w.message(2, (fw) => {
      fw.uint(1, row.id)
      fw.packed(2, row.tags)
      fw.uint(3, row.type) // 1=POINT 2=LINESTRING 3=POLYGON
      fw.packed(4, row.geom)
    })
  }
  for (const k of keys) w.str(3, k)
  for (const v of values) {
    w.message(4, (vw) => {
      if (typeof v === 'string') vw.str(1, v)
      else if (typeof v === 'boolean') vw.uint(7, v ? 1 : 0)
      else if (Number.isInteger(v)) vw.sintField(6, v)
      else vw.double(3, v)
    })
  }
  w.uint(5, layer.extent ?? 4096)
  return w
}

/** 编码一个瓦片：所有图层塞进同一个字节流 */
export function encodeMvt(layers: MvtLayer[]): Uint8Array {
  const w = new Writer()
  for (const layer of layers) {
    // writeLayer 产出的已经是一个完整的 Layer 消息体，这里只补 tag 与长度
    w.messageBytes(3, writeLayer(layer).toBytes())
  }
  return w.toBytes()
}
