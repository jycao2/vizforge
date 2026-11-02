import { onBeforeUnmount, type Ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
// Vite 打包后 worker 的相对路径会失效，这里显式把 worker 打成一个 chunk 并回填 URL
import mbWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
maplibregl.config.WORKER_URL = mbWorkerUrl
import 'maplibre-gl/dist/maplibre-gl.css'
import './mb-ui.css'
import { MB_DEFAULT, rasterStyle } from './basemaps'
import { provideMapHost } from '@/components/mapHost'

export type { StyleSpecification, Map as MbMap, MapMouseEvent, MapLayerMouseEvent } from 'maplibre-gl'

export interface MbView {
  center: [number, number]
  zoom: number
  bearing?: number
  pitch?: number
}

export interface MbOptions extends Partial<MbView> {
  /** 不传就用深色栅格底图；传对象则是自己的 style */
  style?: string | maplibregl.StyleSpecification
  interactive?: boolean
  attribution?: boolean
  /** 是否挂 NavigationControl */
  navigation?: boolean
  /** 需要 canvas.toDataURL 导出图片时必须为 true，否则缓冲区绘制完就被清空 */
  preserveDrawingBuffer?: boolean
}

/**
 * 把 map 交给工具栏（测距 / 测面）。
 * 取实例是函数：地图在 onMounted 里才 new 出来，provide 时还是 null。
 */
export function useMapboxHost(getMap: () => maplibregl.Map | null): void {
  provideMapHost(() => {
    const m = getMap()
    return m ? { kind: 'mapbox', instance: m } : null
  })
}

/**
 * 建地图。
 *
 * 关于引擎：Mapbox GL JS 从 v2 起强制校验 accessToken（无 Token 会把画布直接清空），
 * 所以本目录用的是 MapLibre GL —— Mapbox GL v1 的开源分支，样式规范、表达式、
 * 图层类型与 API 全部兼容，且不做任何 Token 校验，示例开箱即用。
 */
export function createMap(
  el: HTMLElement,
  opts: MbOptions = {},
): maplibregl.Map {
  // 字符串形式的 style 是本项目的底图 id（'dark' 等），要现拼成完整 style；
  // 直接把字符串塞给 Map 会被当成 style URL 去请求，得到一整幅 404 的空地图
  const style =
    typeof opts.style === 'string'
      ? rasterStyle(opts.style)
      : (opts.style ?? rasterStyle(MB_DEFAULT))
  const map = new maplibregl.Map({
    container: el,
    style,
    center: opts.center ?? [120.15, 30.27],
    zoom: opts.zoom ?? 12,
    bearing: opts.bearing ?? 0,
    pitch: opts.pitch ?? 0,
    attributionControl: opts.attribution === false ? false : { compact: true },
    logoPosition: 'bottom-left',
    interactive: opts.interactive !== false,
    // MapLibre 用 canvasContextAttributes 透传 WebGL 上下文参数
    canvasContextAttributes: {
      antialias: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer === true,
    },
    fadeDuration: 120,
  })
  if (opts.navigation !== false) {
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
  }
  if (opts.attribution !== false) {
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left')
  }
  return map
}

/** 视图操作：放大 / 缩小 / 复位 / 全屏，供 MapControls 直接绑定 */
export function useMapboxView(getMap: () => maplibregl.Map | null, home: MbView) {
  // 顺手把实例交给工具栏，页面就不用再调 useMapboxHost
  useMapboxHost(getMap)

  function zoomBy(delta: number) {
    const m = getMap()
    if (!m) return
    m.easeTo({ zoom: m.getZoom() + delta, duration: 220 })
  }
  function reset() {
    getMap()?.flyTo({
      center: home.center,
      zoom: home.zoom,
      bearing: home.bearing ?? 0,
      pitch: home.pitch ?? 0,
      duration: 700,
    })
  }
  async function toggleFullscreen(el?: HTMLElement) {
    if (!el) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.requestFullscreen()
  }
  return { zoomBy, reset, toggleFullscreen }
}

/**
 * style 换掉之后，之前 addLayer/addSource 的东西全没了 —— 底图切换必须重挂业务图层。
 * 这里统一「等 style 就绪再跑初始化」的写法，避免 setStyle 后图层消失。
 */
export function onStyleReady(map: maplibregl.Map, fn: () => void) {
  if (map.isStyleLoaded()) {
    fn()
    return
  }
  map.once('style.load', fn)
}

/** 换底图并保持业务图层：先记住回调，换完再执行 */
export function swapBasemap(map: maplibregl.Map, styleId: string, reAdd: () => void) {
  map.setStyle(rasterStyle(styleId))
  map.once('style.load', reAdd)
}

/**
 * 把底图压暗（大屏系列用）。
 *
 * Esri 深灰底图直接当大屏背景还是太亮，HUD 和发光图层都压不住它；
 * 只动 raster 图层的三个 paint 参数 —— 亮度打下来、饱和度抽掉、对比度抬一点，
 * 底图立刻从「地图」退成「背景」。必须在 load 之后调用（style 还没就绪时取不到图层）。
 */
export function dimBasemap(map: maplibregl.Map, strength = 1) {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === 'raster') {
      map.setPaintProperty(layer.id, 'raster-brightness-max', Math.max(0.08, 0.62 - 0.24 * strength))
      map.setPaintProperty(layer.id, 'raster-saturation', -0.38 * strength)
      map.setPaintProperty(layer.id, 'raster-contrast', 0.1 * strength)
    }
  }
}

/**
 * 用 canvas 画一张图并注册成 map 的图片（图标、点精灵都用它）。
 * Mapbox 的 icon-image 只认 addImage 注册过的 id，不能直接给 URL。
 */
export function addCanvasImage(
  map: maplibregl.Map,
  id: string,
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  pixelRatio = 2,
) {
  const c = document.createElement('canvas')
  c.width = c.height = size * pixelRatio
  const ctx = c.getContext('2d')!
  ctx.scale(pixelRatio, pixelRatio)
  draw(ctx, size)
  const data = ctx.getImageData(0, 0, c.width, c.height)
  if (map.hasImage(id)) map.removeImage(id)
  map.addImage(id, { width: c.width, height: c.height, data: new Uint8Array(data.data) })
}

/** 圆形径向渐变贴图（热力/光点/发光点都用这一张） */
export function radial(size: number, inner: string, outer = 'rgba(0,0,0,0)') {
  return (ctx: CanvasRenderingContext2D, s: number) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    g.addColorStop(0, inner)
    g.addColorStop(1, outer)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
  }
}

/** 给一组线段做「沿线插值」，用来算弧线、飞线、轨迹上的点 */
export function alongLine(coords: Array<[number, number]>, t: number): [number, number] {
  if (coords.length === 0) return [0, 0]
  if (coords.length === 1) return coords[0]
  const segs: number[] = []
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1])
    segs.push(d)
    total += d
  }
  let want = Math.max(0, Math.min(1, t)) * total
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const k = segs[i] ? want / segs[i] : 0
      return [
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * k,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * k,
      ]
    }
    want -= segs[i]
  }
  return coords[coords.length - 1]
}

/**
 * 二次贝塞尔弧线（经纬度空间），用来画 OD / 飞线。
 * lift 是弧度外推比例，越大拱得越高。
 */
export function bezierArc(
  a: [number, number],
  b: [number, number],
  lift = 0.25,
  steps = 64,
): Array<[number, number]> {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1e-6
  // 中垂线方向外推；南→北的线往上拱，北→南的往下拱（视觉上总在「同一侧」）
  const nx = -dy / len
  const ny = dx / len
  const sign = dy >= 0 ? -1 : 1
  const cx = (a[0] + b[0]) / 2 + nx * len * lift * sign
  const cy = (a[1] + b[1]) / 2 + ny * len * lift * sign
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    pts.push([mt * mt * a[0] + 2 * mt * t * cx + t * t * b[0], mt * mt * a[1] + 2 * mt * t * cy + t * t * b[1]])
  }
  return pts
}

/**
 * line-gradient 流动光带：把 [head-0.16, head] 这一段点亮，其余透明。
 * 每帧只改一个 paint 属性就能让「一颗光点沿线跑」；要求 source 开 lineMetrics。
 *
 * 注意 interpolate 的 stop 必须严格递增：head 逼近 1 时要收住，
 * 否则尾部那个收口 stop 会越过 1 抛「stops must be in ascending order」。
 */
export function flowGradient(head: number, color = '#ffffff'): maplibregl.ExpressionSpecification {
  const h = Math.max(0.001, Math.min(0.97, head))
  const t0 = Math.max(0, h - 0.16)
  const t1 = t0 + (h - t0) * 0.3
  const stops: unknown[] = ['interpolate', ['linear'], ['line-progress']]
  if (t0 > 0) stops.push(0, 'rgba(255,255,255,0)')
  stops.push(t0, 'rgba(255,255,255,0)', t1, 'rgba(255,255,255,0.35)', h, color)
  if (h < 0.97) stops.push(h + 0.02, 'rgba(255,255,255,0)')
  stops.push(1, 'rgba(255,255,255,0)')
  return stops as maplibregl.ExpressionSpecification
}

/** 组件卸载时清掉 rAF / 监听，避免切页后还在跑 */
export function useRaf(loop: (dt: number) => void, refs: Ref<boolean> | null = null) {  let raf = 0
  let last = 0
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    if (refs && !refs.value) {
      last = now
      return
    }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
    last = now
    loop(dt)
  }
  raf = requestAnimationFrame(tick)
  onBeforeUnmount(() => cancelAnimationFrame(raf))
  return { stop: () => cancelAnimationFrame(raf) }
}
