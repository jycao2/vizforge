<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { compileShader, createProgram, lookAt, multiply, perspective, setupGL } from './gl'

const container = ref<HTMLDivElement>()
const hint = ref('按住左键拖动环视')

let cleanup: (() => void) | null = null

/** 每个立方体面：(u,v) → 世界方向，u/v ∈ [-1,1] */
const FACE_DIRS: ((u: number, v: number) => [number, number, number])[] = [
  (u, v) => [1, v, -u], // +X
  (u, v) => [-1, v, u], // -X
  (u, v) => [u, 1, -v], // +Y
  (u, v) => [u, -1, v], // -Y
  (u, v) => [u, v, 1], // +Z
  (u, v) => [-u, v, -1], // -Z
]

/** 逐像素求值的「天空函数」：天顶深蓝 → 地平线暖光 + 太阳 + 星点，地平线以下是暗色地面 */
function skyColor(dx: number, dy: number, dz: number, out: Uint8ClampedArray, o: number) {
  const len = Math.hypot(dx, dy, dz) || 1
  const x = dx / len
  const y = dy / len
  const z = dz / len

  // 太阳方向（固定）
  const sx = -0.55
  const sy = 0.16
  const sz = -0.82

  // 天顶 → 地平线：深蓝到浅蓝
  const up = Math.max(0, y)
  const t = Math.pow(1 - up, 1.35)
  let r = 14 + 66 * t
  let g = 28 + 74 * t
  let b = 88 + 34 * t

  // 暖色只出现在「太阳那一侧」的地平线附近，而不是 360° 一圈
  const sunAz = Math.max(0, (x * sx + z * sz) / Math.hypot(sx, sz) * 0.5 + 0.5)
  const band = Math.exp(-Math.abs(y - 0.01) * 16) * Math.pow(sunAz, 2.4)
  r += 190 * band
  g += 105 * band
  b += 28 * band

  // 太阳本体 + 光晕
  const cosA = Math.max(0, x * sx + y * sy + z * sz)
  const disc = Math.pow(cosA, 1400)
  const halo = Math.pow(cosA, 24) * 0.5 + Math.pow(cosA, 6) * 0.18
  r += 255 * (disc * 3.2 + halo)
  g += 232 * (disc * 2.6 + halo * 0.85)
  b += 180 * (disc * 1.6 + halo * 0.5)

  // 地平线以下：压成暗色地面，避免出现奇怪的绿色
  if (y < 0) {
    const k = Math.min(1, -y * 5.5)
    r = r * (1 - k) + 34 * k
    g = g * (1 - k) + 38 * k
    b = b * (1 - k) + 46 * k
  } else if (y > 0.14) {
    // 星点：用方向做哈希，只出现在高空
    const hs = Math.sin(x * 437.5 + y * 231.7 + z * 761.3) * 43758.5453
    const star = hs - Math.floor(hs)
    if (star > 0.9992) {
      const k = ((star - 0.9992) / 0.0008) * Math.min(1, (y - 0.14) * 6)
      r += 240 * k
      g += 245 * k
      b += 255 * k
    }
  }

  out[o] = Math.min(255, r)
  out[o + 1] = Math.min(255, g)
  out[o + 2] = Math.min(255, b)
  out[o + 3] = 255
}

/** 生成 6 张 256² 的面贴图，保证接缝处颜色连续（同一函数采样） */
function buildCubeFaces(size = 256): HTMLCanvasElement[] {
  const faces: HTMLCanvasElement[] = []
  for (let f = 0; f < 6; f++) {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(size, size)
    const dirFn = FACE_DIRS[f]
    for (let y = 0; y < size; y++) {
      const v = 1 - (2 * (y + 0.5)) / size
      for (let x = 0; x < size; x++) {
        const u = (2 * (x + 0.5)) / size - 1
        const [dx, dy, dz] = dirFn(u, v)
        skyColor(dx, dy, dz, img.data, (y * size + x) * 4)
      }
    }
    ctx.putImageData(img, 0, 0)
    faces.push(canvas)
  }
  return faces
}

const VS = `
attribute vec3 a_pos;
uniform mat4 u_vp;
varying vec3 v_dir;
void main() {
  v_dir = a_pos;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}
`

const FS = `
precision mediump float;
varying vec3 v_dir;
uniform samplerCube u_cube;
void main() {
  gl_FragColor = textureCube(u_cube, normalize(v_dir));
}
`

onMounted(() => {
  const el = container.value
  if (!el) return
  const ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas, resize } = ctx

  const program = createProgram(
    gl,
    VS,
    FS,
  )
  if (!program) return
  gl.useProgram(program)

  // 一个尺寸 200 的立方体，相机始终在原点内部
  const S = 200
  const corners: number[] = []
  const faces: [number, number, number][][] = [
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
    [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
    [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
    [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
    [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  ]
  faces.forEach((quad) => {
    const [a, b, c, d] = quad
    ;[a, b, c, a, c, d].forEach((p) => corners.push(p[0] * S, p[1] * S, p[2] * S))
  })

  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)

  // 立方体贴图
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex)
  const faceImgs = buildCubeFaces(256)
  faceImgs.forEach((img, i) => {
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
  })
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.uniform1i(gl.getUniformLocation(program, 'u_cube'), 0)

  const uVP = gl.getUniformLocation(program, 'u_vp')

  // 视角：拖拽改变 yaw / pitch
  // 初始朝向太阳所在方位，进门就能看到日落
  let yaw = 3.73
  let pitch = 0.08
  let dragging = false
  let lastX = 0
  let lastY = 0

  const onDown = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.style.cursor = 'grabbing'
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    yaw -= (e.clientX - lastX) * 0.0045
    pitch -= (e.clientY - lastY) * 0.0045
    pitch = Math.max(-1.35, Math.min(1.35, pitch))
    lastX = e.clientX
    lastY = e.clientY
  }
  const onUp = () => {
    dragging = false
    canvas.style.cursor = 'grab'
  }
  canvas.style.cursor = 'grab'
  canvas.addEventListener('pointerdown', onDown)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)

  gl.enable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE)

  const onResize = () => {
    resize()
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  window.addEventListener('resize', onResize)

  let raf = 0
  const draw = () => {
    raf = requestAnimationFrame(draw)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0.02, 0.04, 0.08, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    if (!dragging) yaw += 0.0009

    const cx = Math.sin(yaw) * Math.cos(pitch)
    const cy = Math.sin(pitch)
    const cz = Math.cos(yaw) * Math.cos(pitch)
    const view = lookAt([0, 0, 0], [cx, cy, cz], [0, 1, 0])
    const proj = perspective((60 * Math.PI) / 180, canvas.width / canvas.height, 0.1, 1000)
    const vp = multiply(proj, view)

    gl.uniformMatrix4fv(uVP, false, vp)
    gl.drawArrays(gl.TRIANGLES, 0, corners.length / 3)
  }
  draw()

  cleanup = () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('resize', onResize)
    gl.deleteBuffer(vbo)
    gl.deleteTexture(tex)
    gl.deleteProgram(program)
    canvas.remove()
  }
})

onBeforeUnmount(() => {
  cleanup?.()
  cleanup = null
})

function resetView() {
  hint.value = '按住左键拖动环视'
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">立方体贴图天空盒</div>
      <div class="tip">
        6 张面纹理由同一个「天空函数」在 CPU 上逐像素生成，所以接缝天然连续；着色器只用
        textureCube 采样。{{ hint }}
      </div>
      <div class="btns">
        <span class="tag">TEXTURE_CUBE_MAP</span>
        <span class="tag">256² × 6</span>
        <button class="btn" @click="resetView">提示</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.gl-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 340px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(12, 18, 27, 0.82);
  border: 1px solid rgba(90, 110, 135, 0.45);
  backdrop-filter: blur(8px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e6eef7;
}
.tip {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.55;
  color: #93a4b7;
}
.btns {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}
.tag {
  padding: 2px 7px;
  border-radius: 5px;
  background: rgba(79, 157, 255, 0.16);
  border: 1px solid rgba(79, 157, 255, 0.35);
  color: #8ec4ff;
  font-size: 10.5px;
  letter-spacing: 0.02em;
}
.btn {
  margin-left: auto;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: rgba(255, 255, 255, 0.05);
  color: #c6d3e1;
  font-size: 11.5px;
  cursor: pointer;
}
</style>
