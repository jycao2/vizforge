<script setup lang="ts">
/**
 * 自定义 WebGL 图层（Custom Layer）
 * ===========================================================================
 * 样式层不够用时，MapLibre 允许你把自己的 WebGL 代码插进它的渲染管线：
 *
 *  - `type: 'custom'` 的图层有 `onAdd(map, gl)` / `render(gl, args)` 两个钩子；
 *  - v6 的 render 第二参是输入对象：投影矩阵在 `args.defaultProjectionData.mainMatrix`
 *    （兼容 mercator/globe；它作用在归一化墨卡托 0~1 世界坐标上），
 *    不要用 modelViewProjectionMatrix —— 那是内部裁剪管线用的，坐标系不同；
 *  - 顶点坐标用 MercatorCoordinate（0~1，z 也是这个尺度：1 ≈ 地球周长），
 *    高度用 `fromLngLat(lngLat, altitude)` 一步换算；
 *  - `renderingMode: '3d'` 才会启用深度测试，画立体东西必须开；
 *  - 拿到的 gl 是共享上下文，改过的状态要在离开前还原，
 *    半透明体用 depthMask(false) 不写深度，避免挡住后面的图层。
 *
 * 本例画一根 3D 光柱：两片交叉的竖直四边形（避免侧看变成一条线），
 * 高度呼吸、颜色脉动，落地位置就是给定经纬度。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap, CustomLayerInterface } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const height = ref(2400)
let map: MbMap | null = null
let raf = 0

const HOME = { center: [120.152, 30.253] as [number, number], zoom: 14.2, pitch: 60, bearing: -20 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const VERT = `
uniform mat4 u_matrix;
attribute vec3 a_pos;
varying float v_t;
void main() {
  v_t = a_pos.z * 40075016.686;   // 归一化 z 还原成"米"，交给片元做渐变
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}
`

const FRAG = `
precision mediump float;
uniform float u_time;
uniform float u_height;
varying float v_t;
void main() {
  float k = clamp(v_t / max(u_height, 1.0), 0.0, 1.0);
  // 底部亮、顶部淡出；再叠一层上下扫动的亮带
  float base = pow(1.0 - k, 1.6);
  float pulse = smoothstep(0.35, 0.0, abs(fract(u_time * 0.25) - k));
  vec3 col = mix(vec3(0.31, 0.79, 1.0), vec3(1.0, 0.85, 0.45), pulse);
  gl_FragColor = vec4(col, base * (0.35 + 0.5 * pulse));
}
`

interface GL2 extends WebGLRenderingContext {
  program?: WebGLProgram | null
  aPos?: number
  uMatrix?: WebGLUniformLocation | null
  uTime?: WebGLUniformLocation | null
  uHeight?: WebGLUniformLocation | null
  buffer?: WebGLBuffer | null
}

/** 造一根光柱：两片互相垂直的四边形，共 12 个顶点（两个三角形 × 2） */
function beamVerts(center: [number, number], h: number, halfWidth: number): Float32Array {
  const mc = maplibregl.MercatorCoordinate
  const base = mc.fromLngLat(center, 0)
  const top = mc.fromLngLat(center, h)
  const w = halfWidth
  // 第一片：沿 x 方向展开；第二片：沿 y 方向展开
  const quad = (dx: number, dy: number): number[] => [
    base.x - dx, base.y - dy, base.z,
    base.x + dx, base.y + dy, base.z,
    top.x + dx, top.y + dy, top.z,
    base.x - dx, base.y - dy, base.z,
    top.x + dx, top.y + dy, top.z,
    top.x - dx, top.y - dy, top.z,
  ]
  return new Float32Array([...quad(w, 0), ...quad(0, w)])
}

const layer: CustomLayerInterface = {
  id: 'beam',
  type: 'custom',
  renderingMode: '3d',
  onAdd(_map: MbMap, gl: WebGLRenderingContext) {
    const g = gl as GL2
    const prog = gl.createProgram()!
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[custom layer] shader:', gl.getShaderInfoLog(s))
      }
      return s
    }
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    g.program = prog
    g.aPos = gl.getAttribLocation(prog, 'a_pos')
    g.uMatrix = gl.getUniformLocation(prog, 'u_matrix')
    g.uTime = gl.getUniformLocation(prog, 'u_time')
    g.uHeight = gl.getUniformLocation(prog, 'u_height')
    g.buffer = gl.createBuffer()
  },
  render(gl, args) {
    const g = gl as GL2
    if (!g.program || !map) return

    gl.useProgram(g.program)
    // v6 里投影矩阵在 defaultProjectionData.mainMatrix 上（作用在归一化墨卡托坐标）
    gl.uniformMatrix4fv(
      g.uMatrix!,
      false,
      new Float32Array(args.defaultProjectionData.mainMatrix as unknown as Float64Array),
    )
    gl.uniform1f(g.uTime!, performance.now() / 1000)
    gl.uniform1f(g.uHeight!, height.value)

    // 顶点每次重算：高度可调
    // 半宽 1.5e-6 归一化约 60m：全宽 120m，在城市尺度下是一根细柱
    const verts = beamVerts(HOME.center, height.value, 0.0000015)
    gl.bindBuffer(gl.ARRAY_BUFFER, g.buffer!)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(g.aPos!)
    gl.vertexAttribPointer(g.aPos!, 3, gl.FLOAT, false, 0, 0)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(false) // 半透明光柱不写深度，避免挡住后面的建筑
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 3)
    gl.depthMask(true)
  },
}

function setHeight(v: number) {
  height.value = v
  map?.triggerRepaint()
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  map!.on('load', () => {
    map!.addLayer(layer)
    // 光柱要一直动，得让地图持续重绘
    const spin = () => {
      raf = requestAnimationFrame(spin)
      map?.triggerRepaint()
    }
    raf = requestAnimationFrame(spin)
  })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  map?.remove()
  map = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>
    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-panel ctrl">
      <h4>自定义 WebGL 图层</h4>
      <label class="mb-row">
        <span>柱高</span>
        <input
          type="range"
          min="400"
          max="6000"
          step="100"
          :value="height"
          @input="setHeight(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ height }}m</b>
      </label>
      <div class="hint">renderingMode 3d · MercatorCoordinate 定位 · 共享 GL 上下文</div>
    </div>
    <div class="mb-tip">两片交叉四边形组成的光柱，深度写入关闭以免遮挡建筑</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 232px;
}
.mb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
}
.mb-row input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4f9dff;
}
.mb-row b {
  width: 46px;
  text-align: right;
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
