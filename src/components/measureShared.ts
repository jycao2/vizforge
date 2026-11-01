/**
 * 量测公共部件：类型、数值格式、跟随鼠标的浮标
 * ===========================================================================
 * OL 与 Cesium 两套实现各自维护几何，但读数规则与提示浮标必须一致，
 * 否则同一个「测距」按钮在二维页和三维页给出的数字格式会不一样。
 */

export type MeasureKind = 'line' | 'area' | 'height'

export interface MeasureUpdate {
  /** 主读数，如 "12.34 km" */
  text: string
  /** 副读数，如 "周长 2.10 km" */
  detail?: string
  /** 是否已经结束（双击/拾取完毕） */
  done: boolean
}

export interface MeasureHandle {
  /** 结束当前测量，保留已画图形 */
  stop(): void
  /** 彻底销毁：移除图形、浮标与监听 */
  dispose(): void
}

/** 长度：<1km 用米，否则公里 */
export function fmtLength(m: number): string {
  if (!Number.isFinite(m)) return '—'
  if (m < 1000) return `${m < 10 ? m.toFixed(2) : m.toFixed(1)} m`
  return `${(m / 1000).toFixed(2)} km`
}

/** 面积：平方米 → 公顷 → 平方公里 */
export function fmtArea(m2: number): string {
  if (!Number.isFinite(m2)) return '—'
  if (m2 < 10000) return `${m2.toFixed(0)} m²`
  if (m2 < 1e6) return `${(m2 / 10000).toFixed(2)} 公顷`
  return `${(m2 / 1e6).toFixed(2)} km²`
}

export interface MeasureTip {
  /** 更新读数；main 为空时隐藏 */
  set(main: string, sub?: string): void
  /** 按容器内像素坐标定位 */
  moveTo(x: number, y: number): void
  hide(): void
  destroy(): void
}

/**
 * 跟随鼠标的读数浮标。
 * 用绝对定位而不是 OL 的 Overlay / Cesium 的 Label：
 * 两套地图都能用同一份 DOM，样式一致，也不用分别处理坐标系。
 */
export function createMeasureTip(host: HTMLElement): MeasureTip {
  const el = document.createElement('div')
  Object.assign(el.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    zIndex: '35',
    pointerEvents: 'none',
    padding: '6px 10px',
    borderRadius: '7px',
    background: 'rgba(12, 18, 26, 0.93)',
    border: '1px solid rgba(79, 157, 255, 0.55)',
    boxShadow: '0 8px 20px rgba(0, 0, 0, 0.42)',
    color: '#eaf2fb',
    fontSize: '12px',
    lineHeight: '1.4',
    whiteSpace: 'nowrap',
    transform: 'translate(14px, 12px)',
    display: 'none',
    transition: 'opacity 0.12s ease',
  } as Partial<CSSStyleDeclaration>)

  const main = document.createElement('div')
  main.style.fontWeight = '600'
  main.style.fontVariantNumeric = 'tabular-nums'
  const sub = document.createElement('div')
  sub.style.fontSize = '10px'
  sub.style.color = '#8fa4b9'
  sub.style.marginTop = '2px'

  el.appendChild(main)
  el.appendChild(sub)
  host.appendChild(el)

  return {
    set(text: string, detail?: string) {
      if (!text) {
        el.style.display = 'none'
        return
      }
      main.textContent = text
      sub.textContent = detail ?? ''
      sub.style.display = detail ? 'block' : 'none'
    },
    moveTo(x: number, y: number) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.style.display = 'block'
    },
    hide() {
      el.style.display = 'none'
    },
    destroy() {
      el.remove()
    },
  }
}

/** 球面多边形面积（平方米）。用于 Cesium 侧，OL 直接用 ol/sphere 的 getArea */
export function sphericalArea(ring: Array<[number, number]>): number {
  // 与 ol/sphere.getArea 同源的近似算法：按纬带梯形积分
  const R = 6378137
  const rad = Math.PI / 180
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i]
    const [lon2, lat2] = ring[(i + 1) % ring.length]
    total += (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad))
  }
  return Math.abs((total * R * R) / 2)
}
