/**
 * 抓取 OpenStreetMap 路网 → 精简 JSON
 * ===========================================================================
 * 用法：
 *   node scripts/fetch-osm-roadnet.mjs --bbox=120.1465,30.2425,120.1746,30.2744 \
 *        --out=src/examples/openlayers/data/hangzhou-roadnet.json --name="杭州西湖东侧"
 *   node scripts/fetch-osm-roadnet.mjs --file=/tmp/osm.xml --out=... （用已缓存的 XML，免二次请求）
 *
 * 为什么固化成本地 JSON 而不是页面里实时请求：
 *   1. OSM 官方 /map 接口限 0.25 平方度且明确要求低频访问，不适合运行时调用；
 *   2. 公开 Overpass 镜像国内基本连不上（实测三个实例全部超时）；
 *   3. 数据固化后示例完全离线可跑，与项目其他示例的定位一致。
 *
 * 输出结构（紧凑，便于直接喂给寻路算法）：
 *   { meta: {...}, nodes: [[lon,lat], ...], edges: [[a, b, speedKmh], ...] }
 *
 * 数据许可：© OpenStreetMap contributors, ODbL 1.0 —— 页面需保留署名。
 */
import fs from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=')
    return [k, rest.join('=') || 'true']
  }),
)

const bbox = args.bbox || '120.1465,30.2425,120.1746,30.2744'
const out = args.out || 'src/examples/openlayers/data/roadnet.json'
const name = args.name || 'OSM 路网'

/** 只保留可通车的道路等级 */
const HIGHWAY = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
])

/** 道路等级 → 通行速度（km/h），参考各地城市道路限速 */
const SPEED = {
  motorway: 100,
  trunk: 80,
  primary: 60,
  secondary: 50,
  tertiary: 40,
  residential: 25,
  unclassified: 30,
  living_street: 15,
}
const speedOf = (hw) => SPEED[hw] ?? SPEED.residential

async function fetchXml() {
  if (args.file) return fs.readFileSync(args.file, 'utf8')
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'vizforge-example/1.0 (road network demo; contact: repo owner)' },
  })
  if (!res.ok) throw new Error(`OSM ${res.status} ${res.statusText}`)
  return res.text()
}

/** 轻量 XML 解析：只关心 node / way(nd, tag)，正则足够且不用引第三方依赖 */
function parse(xml) {
  const nodes = new Map()
  // 注意属性顺序不固定（id/version/timestamp/user.../lat/lon），
  // 不能假设 lat 紧跟 id，先取整个标签再分别抠属性
  const nodeRe = /<node\b([^>]*)>/g
  let m
  while ((m = nodeRe.exec(xml))) {
    const attrs = m[1]
    const id = /\bid="(\d+)"/.exec(attrs)?.[1]
    const lat = /\blat="([-\d.]+)"/.exec(attrs)?.[1]
    const lon = /\blon="([-\d.]+)"/.exec(attrs)?.[1]
    if (id && lat && lon) nodes.set(id, [Number(lon), Number(lat)])
  }

  const ways = []
  const wayRe = /<way\s+id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g
  while ((m = wayRe.exec(xml))) {
    const body = m[2]
    const hw = /<tag\s+k="highway"\s+v="([^"]+)"/.exec(body)?.[1]
    if (!hw || !HIGHWAY.has(hw)) continue
    // 隧道/桥梁照常参与寻路，但被 service=parking_aisle 之类的排除
    if (/<tag\s+k="access"\s+v="(no|private)"/.test(body)) continue
    if (/<tag\s+k="motor_vehicle"\s+v="no"/.test(body)) continue
    const refs = []
    const ndRe = /<nd\s+ref="(\d+)"/g
    let nd
    while ((nd = ndRe.exec(body))) if (nodes.has(nd[1])) refs.push(nd[1])
    if (refs.length < 2) continue
    const roadName = /<tag\s+k="name"\s+v="([^"]+)"/.exec(body)?.[1] ?? ''
    ways.push({ hw, refs, roadName })
  }
  return { nodes, ways }
}

/** OSM 节点 id → 紧凑下标；同一对节点之间保留最快的那条 */
function build(nodes, ways) {
  const index = new Map()
  const pts = []
  const idOf = (nid) => {
    let k = index.get(nid)
    if (k === undefined) {
      k = pts.length
      index.set(nid, k)
      pts.push(nodes.get(nid))
    }
    return k
  }

  const edgeMap = new Map()
  for (const w of ways) {
    const speed = speedOf(w.hw)
    for (let i = 1; i < w.refs.length; i++) {
      const a = idOf(w.refs[i - 1])
      const b = idOf(w.refs[i])
      if (a === b) continue
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      const prev = edgeMap.get(key)
      if (!prev || speed > prev[2]) edgeMap.set(key, [a, b, speed])
    }
  }

  // 只保留被道路引用到的节点
  return { nodes: pts, edges: Array.from(edgeMap.values()) }
}

const xml = await fetchXml()
const { nodes, ways } = parse(xml)
const { nodes: pts, edges } = build(nodes, ways)

const payload = {
  meta: {
    name,
    bbox: bbox.split(',').map(Number),
    source: 'OpenStreetMap',
    license: 'ODbL 1.0',
    fetched: new Date().toISOString().slice(0, 10),
    ways: ways.length,
  },
  nodes: pts.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
  edges,
}

fs.mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true })
fs.writeFileSync(out, JSON.stringify(payload))

const size = fs.statSync(out).size
console.log(`✅ ${out}`)
console.log(`   路口 ${pts.length} · 路段 ${edges.length} · 原始 way ${ways.length} · ${(size / 1024).toFixed(0)} KB`)
