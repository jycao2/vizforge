/**
 * Mapbox 量测：测距 / 测面
 * ===========================================================================
 * 自己收集点击坐标，用 GeoJSON source 实时回写几何：
 *  - 单击加点，鼠标移动更新预览段，双击结束；
 *  - 长度用 Haversine 球面距离逐段累加，面积用纬带梯形积分（与 OL 侧同一套算法）；
 *  - 量测期间关掉双击缩放，否则结束那一下会顺带把地图放大一级。
 */
import type { Map as MbMap, GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
import {
  createMeasureTip,
  fmtArea,
  fmtLength,
  sphericalArea,
  type MeasureHandle,
  type MeasureUpdate,
} from '@/components/measureShared'

type LL = [number, number]

/** 大地线长度（米）。纬度 30° 处经度 1° 约 96km，不能用平面距离近似 */
function haversine(a: LL, b: LL): number {
  const R = 6378137
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const la1 = a[1] * rad
  const la2 = b[1] * rad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function pathLength(pts: LL[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += haversine(pts[i - 1], pts[i])
  return s
}

const SRC = 'mb-measure-src'
const L_FILL = 'mb-measure-fill'
const L_LINE = 'mb-measure-line'
const L_DOT = 'mb-measure-dot'

export function startMbMeasure(
  map: MbMap,
  kind: 'line' | 'area',
  onUpdate: (u: MeasureUpdate) => void = () => {},
): MeasureHandle {
  const host = map.getContainer()
  const tip = createMeasureTip(host)

  const points: LL[] = []
  let cursor: LL | null = null
  let finished = false

  map.addSource(SRC, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })

  map.addLayer({
    id: L_FILL,
    type: 'fill',
    source: SRC,
    filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': '#4f9dff', 'fill-opacity': 0.16 },
  })
  map.addLayer({
    id: L_LINE,
    type: 'line',
    source: SRC,
    paint: {
      'line-color': '#4f9dff',
      'line-width': 2.2,
      'line-dasharray': [2, 1.4],
    },
  })
  map.addLayer({
    id: L_DOT,
    type: 'circle',
    source: SRC,
    filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': 4.5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#2f6fd0',
      'circle-stroke-width': 2,
    },
  })

  /** 已定点 + 跟随鼠标的那一段，合成一个待渲染的集合 */
  function flush() {
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    if (!src) return
    const live = cursor ? [...points, cursor] : points
    const features: GeoJSON.Feature[] = points.map((p) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: p },
    }))
    if (live.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: live,
        },
      })
    }
    if (kind === 'area' && live.length >= 3) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[...live, live[0]]] },
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }

  function read(): MeasureUpdate {
    const live = cursor ? [...points, cursor] : points
    if (kind === 'line') {
      return {
        text: fmtLength(pathLength(live)),
        detail: live.length ? `${live.length - 1} 段 · 双击结束` : '点击开始',
        done: false,
      }
    }
    if (live.length < 3) {
      return { text: fmtLength(pathLength(live)), detail: '再点两点围合', done: false }
    }
    const a = sphericalArea([...live, live[0]])
    return { text: fmtArea(a), detail: `周长 ${fmtLength(pathLength([...live, live[0]]))}`, done: false }
  }

  function emit() {
    const u = read()
    onUpdate(u)
    tip.set(u.text, u.detail)
  }

  function onClick(e: MapMouseEvent) {
    // 双击会先派发两次 click，第二次 detail 为 2 —— 不能当成加点
    if ((e.originalEvent as MouseEvent).detail > 1 || finished) return
    points.push([e.lngLat.lng, e.lngLat.lat])
    flush()
    emit()
  }

  function onMove(e: MapMouseEvent) {
    cursor = [e.lngLat.lng, e.lngLat.lat]
    flush()
    emit()
    tip.moveTo(e.point.x, e.point.y)
  }

  function finish() {
    if (finished) return
    finished = true
    cursor = null
    flush()
    const u = read()
    onUpdate({ ...u, detail: '已结束', done: true })
    tip.hide()
    cleanup()
  }

  const hadDoubleClickZoom = map.doubleClickZoom.isEnabled()
  if (hadDoubleClickZoom) map.doubleClickZoom.disable()

  function cleanup() {
    map.off('click', onClick)
    map.off('mousemove', onMove)
    map.off('dblclick', finish)
    if (hadDoubleClickZoom) map.doubleClickZoom.enable()
  }

  map.on('click', onClick)
  map.on('mousemove', onMove)
  map.on('dblclick', finish)

  tip.set('点击开始测量', kind === 'line' ? '沿路点击，双击结束' : '点击围合，双击结束')
  const size = map.getCanvas().getBoundingClientRect()
  tip.moveTo(size.width / 2, size.height / 2 - 40)

  return {
    stop: finish,
    dispose() {
      finish()
      if (map.getLayer(L_DOT)) map.removeLayer(L_DOT)
      if (map.getLayer(L_LINE)) map.removeLayer(L_LINE)
      if (map.getLayer(L_FILL)) map.removeLayer(L_FILL)
      if (map.getSource(SRC)) map.removeSource(SRC)
      tip.destroy()
    },
  }
}
