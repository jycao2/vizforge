/**
 * OpenLayers 量测：测距 / 测面
 * ===========================================================================
 * 用 ol/interaction/Draw 收集节点，几何 change 事件里实时算长度与面积，
 * 双击结束。长度与面积都按 EPSG:3857 投影交给 ol/sphere 做测地计算，
 * 不能直接量平面像素距离（纬度 30° 处经度方向会被压缩约 14%）。
 */
import type OlMap from 'ol/Map'
import type { MapBrowserEvent } from 'ol'
import Draw from 'ol/interaction/Draw'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Style from 'ol/style/Style'
import Fill from 'ol/style/Fill'
import Stroke from 'ol/style/Stroke'
import CircleStyle from 'ol/style/Circle'
import { getArea, getLength } from 'ol/sphere'
import type Geometry from 'ol/geom/Geometry'
import {
  createMeasureTip,
  fmtArea,
  fmtLength,
  type MeasureHandle,
  type MeasureUpdate,
} from '@/components/measureShared'

export function startOlMeasure(
  map: OlMap,
  kind: 'line' | 'area',
  onUpdate: (u: MeasureUpdate) => void = () => {},
): MeasureHandle {
  const host = map.getTargetElement() as HTMLElement
  const tip = createMeasureTip(host)

  const source = new VectorSource()
  const layer = new VectorLayer({
    source,
    zIndex: 999,
    style: new Style({
      fill: new Fill({ color: 'rgba(79, 157, 255, 0.16)' }),
      stroke: new Stroke({ color: '#4f9dff', width: 2.2 }),
      image: new CircleStyle({
        radius: 4.5,
        fill: new Fill({ color: '#ffffff' }),
        stroke: new Stroke({ color: '#2f6fd0', width: 2 }),
      }),
    }),
  })
  map.addLayer(layer)

  const draw = new Draw({
    source,
    type: kind === 'line' ? 'LineString' : 'Polygon',
    style: new Style({
      fill: new Fill({ color: 'rgba(79, 157, 255, 0.12)' }),
      stroke: new Stroke({ color: '#7bbcff', width: 2, lineDash: [7, 5] }),
      image: new CircleStyle({ radius: 3.5, fill: new Fill({ color: '#7bbcff' }) }),
    }),
  })

  let geom: Geometry | null = null
  let last: MeasureUpdate = { text: '', done: false }

  /** 按几何类型给出读数 */
  function read(g: Geometry): MeasureUpdate {
    if (kind === 'line') {
      return { text: fmtLength(getLength(g, { projection: 'EPSG:3857' })), detail: '双击结束', done: false }
    }
    const area = getArea(g, { projection: 'EPSG:3857' })
    const peri = getLength(g, { projection: 'EPSG:3857' })
    return { text: fmtArea(area), detail: `周长 ${fmtLength(peri)}`, done: false }
  }

  draw.on('drawstart', (e) => {
    geom = e.feature.getGeometry() ?? null
    geom?.on('change', () => {
      if (!geom) return
      last = read(geom)
      onUpdate(last)
      tip.set(last.text, last.detail)
    })
  })

  draw.on('drawend', () => {
    last = { ...last, done: true }
    onUpdate(last)
    tip.hide()
    map.removeInteraction(draw)
  })

  map.addInteraction(draw)

  const onMove = (evt: MapBrowserEvent<PointerEvent>) => {
    const p = map.getPixelFromCoordinate(evt.coordinate)
    if (p) tip.moveTo(p[0], p[1])
  }
  map.on('pointermove', onMove)

  tip.set('点击开始测量', kind === 'line' ? '沿路点击，双击结束' : '点击围合，双击结束')
  const size = map.getSize()
  if (size) tip.moveTo(size[0] / 2, size[1] / 2 - 40)

  function stop() {
    if (map.getInteractions().getArray().includes(draw)) map.removeInteraction(draw)
    map.un('pointermove', onMove)
  }

  return {
    stop,
    dispose() {
      stop()
      map.removeLayer(layer)
      tip.destroy()
    },
  }
}
