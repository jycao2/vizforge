<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  bindFramebuffer,
  createCube,
  createFramebuffer,
  createProgram,
  deleteFramebuffer,
  lookAt,
  multiply,
  perspective,
  rotationY,
  scaling,
  scaling3,
  setupGL,
  translation,
  type Framebuffer,
  type GLContext,
} from './gl'

/**
 * GPU 拾取（颜色即 ID）
 *
 * 鼠标位置拾取物体有几种做法：CPU 射线求交（要维护 BVH）、几何 ID 缓冲、以及这个最省事也最常用的
 * 「颜色编码」—— 把每个物体的索引写成 RGB 再渲染一遍，读回鼠标那一个像素就知道点到了谁。
 *
 * 代价是 readPixels 是同步操作，会打断 GPU 流水线，所以这里做了节流（120ms 一次）。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

const count = ref(400)
const idView = ref(false)
const hovered = ref(-1)
const selected = ref(-1)
const pickMs = ref(0)
const stats = ref({ fps: 0 })

const GRID = 20 // 20 × 20 最多 400 个

let prog: WebGLProgram | null = null
let idProg: WebGLProgram | null = null
let cube = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let idFbo: Framebuffer | null = null
let u: Record<string, WebGLUniformLocation | null> = {}
let uId: Record<string, WebGLUniformLocation | null> = {}

let mouse = { x: 0, y: 0, inside: false }
let lastPick = 0
let lastHit = 0
let frames = 0
let lastFps = performance.now()

/** 物体数据：位置 + 颜色（固定种子，切换数量时布局稳定） */
const objects: Array<{ x: number; y: number; z: number; color: [number, number, number]; rot: number }> = []

function buildObjects() {
  objects.length = 0
  let seed = 20261103
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const cx = (x - (GRID - 1) / 2) * 1.05
      const cz = (z - (GRID - 1) / 2) * 1.05
      objects.push({
        x: cx,
        y: 0.28 + rand() * 0.35,
        z: cz,
        color: [0.35 + rand() * 0.55, 0.4 + rand() * 0.5, 0.5 + rand() * 0.45],
        rot: rand() * Math.PI,
      })
    }
  }
}

const VS = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform float uScale;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos * uScale, 1.0);
  vWorld = w.xyz;
  vN = normalize(uNormalMat * aNormal);
  gl_Position = uProj * uView * w;
}
`

const FS = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vWorld;
uniform vec3 uColor;
uniform float uSelected;
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(vec3(0.45, 0.9, 0.4));
  float diff = max(dot(N, L), 0.0);
  float rim = pow(1.0 - max(dot(N, vec3(0.0, 0.0, 1.0)), 0.0), 2.0);
  vec3 c = uColor * (0.28 + 0.8 * diff) + vec3(0.1) * rim;
  // 选中：整体提亮 + 边缘发光，不改几何
  // 选中态：直接给一个自发光青色，不受光照影响
  c = mix(c, vec3(0.02, 0.85, 1.0) + vec3(rim * 0.6), uSelected);
  gl_FragColor = vec4(c, 1.0);
}
`

/** ID pass：把索引编码成 RGB（1 起始，0 表示背景） */
const FS_ID = /* glsl */ `
precision highp float;
uniform vec3 uIdColor;
void main() {
  gl_FragColor = vec4(uIdColor, 1.0);
}
`

function compile() {
  const gl = ctx!.gl
  prog = createProgram(gl, VS, FS)
  idProg = createProgram(gl, VS, FS_ID)
  if (!prog || !idProg) return false
  u = {
    uProj: gl.getUniformLocation(prog, 'uProj'),
    uView: gl.getUniformLocation(prog, 'uView'),
    uModel: gl.getUniformLocation(prog, 'uModel'),
    uNormalMat: gl.getUniformLocation(prog, 'uNormalMat'),
    uScale: gl.getUniformLocation(prog, 'uScale'),
    uColor: gl.getUniformLocation(prog, 'uColor'),
    uSelected: gl.getUniformLocation(prog, 'uSelected'),
  }
  uId = {
    uProj: gl.getUniformLocation(idProg, 'uProj'),
    uView: gl.getUniformLocation(idProg, 'uView'),
    uModel: gl.getUniformLocation(idProg, 'uModel'),
    uNormalMat: gl.getUniformLocation(idProg, 'uNormalMat'),
    uScale: gl.getUniformLocation(idProg, 'uScale'),
    uIdColor: gl.getUniformLocation(idProg, 'uIdColor'),
  }
  return true
}

function buildGeometry() {
  const gl = ctx!.gl
  const c = createCube()
  cube.count = c.indices.length
  cube.pos = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, cube.pos)
  gl.bufferData(gl.ARRAY_BUFFER, c.positions, gl.STATIC_DRAW)
  cube.nrm = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, cube.nrm)
  gl.bufferData(gl.ARRAY_BUFFER, c.normals, gl.STATIC_DRAW)
  cube.idx = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.idx)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, c.indices, gl.STATIC_DRAW)
}

function idColor(i: number): [number, number, number] {
  const v = i + 1
  return [(v & 255) / 255, ((v >> 8) & 255) / 255, ((v >> 16) & 255) / 255]
}

/** 用当前投影/视图把场景画一遍（idMode 决定着色） */
function drawScene(
  program: WebGLProgram,
  locs: Record<string, WebGLUniformLocation | null>,
  idMode: boolean,
) {
  const gl = ctx!.gl
  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((45 * Math.PI) / 180, aspect, 0.1, 200)
  const view = lookAt([0, 19, 15], [0, 0, 0], [0, 1, 0])
  gl.useProgram(program)
  gl.uniformMatrix4fv(locs.uProj, false, proj)
  gl.uniformMatrix4fv(locs.uView, false, view)
  gl.uniform1f(locs.uScale, 1)

  gl.bindBuffer(gl.ARRAY_BUFFER, cube.pos)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, cube.nrm)
  const aNrm = gl.getAttribLocation(program, 'aNormal')
  gl.enableVertexAttribArray(aNrm)
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.idx)

  const n = Math.min(count.value, objects.length)
  for (let i = 0; i < n; i++) {
    if (!idMode && i === selected.value) continue
    const o = objects[i]
    const m = multiply(
      // 悬停的物体抬起来一点：阵列密集时，仅靠提亮根本找不到
      multiply(translation(o.x, o.y + (i === hovered.value && !idMode ? 0.85 : 0), o.z), rotationY(o.rot)),
      scaling3(0.36, 0.55 + (i % 7) * 0.07, 0.36),
    )
    const nm = new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
    gl.uniformMatrix4fv(locs.uModel, false, m)
    gl.uniformMatrix3fv(locs.uNormalMat, false, nm)
    gl.uniform1f(locs.uScale, !idMode && i === hovered.value ? 1.28 : 1)
    if (idMode) {
      const c = idColor(i)
      gl.uniform3f(locs.uIdColor, c[0], c[1], c[2])
    } else {
      gl.uniform3f(locs.uColor, o.color[0], o.color[1], o.color[2])
      gl.uniform1f(locs.uSelected, i === hovered.value ? 1 : 0)
    }
    gl.drawElements(gl.TRIANGLES, cube.count, gl.UNSIGNED_SHORT, 0)
  }

  // 选中的那个：最后单独画一次，抬高 + 放大 + 青色，并临时关掉深度测试保证一定可见
  if (!idMode && selected.value >= 0 && selected.value < n) {
    gl.disable(gl.DEPTH_TEST)
    const o = objects[selected.value]
    const m = multiply(
      multiply(translation(o.x, o.y + 1.2, o.z), rotationY(o.rot)),
      scaling3(0.52, 0.9 + (selected.value % 7) * 0.07, 0.52),
    )
    const nm = new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
    gl.uniformMatrix4fv(locs.uModel, false, m)
    gl.uniformMatrix3fv(locs.uNormalMat, false, nm)
    gl.uniform1f(locs.uScale, 1)
    gl.uniform3f(locs.uColor, 0.45, 0.92, 1.0)
    gl.uniform1f(locs.uSelected, 1)
    gl.drawElements(gl.TRIANGLES, cube.count, gl.UNSIGNED_SHORT, 0)
    gl.enable(gl.DEPTH_TEST)
  }
}

function pick() {
  if (!ctx || !idProg || !idFbo || !mouse.inside) return
  const gl = ctx!.gl
  const t0 = performance.now()

  bindFramebuffer(gl, idFbo, ctx!.canvas.width, ctx!.canvas.height)
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  drawScene(idProg, uId, true)
  gl.disable(gl.DEPTH_TEST)

  const px = new Uint8Array(4)
  const dpr = ctx!.canvas.width / Math.max(1, ctx!.canvas.clientWidth)
  const x = Math.round(mouse.x * dpr)
  const y = Math.round((ctx!.canvas.clientHeight - mouse.y) * dpr)
  gl.readPixels(
    Math.min(ctx!.canvas.width - 1, Math.max(0, x)),
    Math.min(ctx!.canvas.height - 1, Math.max(0, y)),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    px,
  )
  const id = px[0] + (px[1] << 8) + (px[2] << 16)
  if (id > 0) {
    hovered.value = id - 1
    lastHit = performance.now()
  } else if (performance.now() - lastHit > 320) {
    // 鼠标在方块之间的缝隙里时读到背景，短时间保留上一次命中，避免高亮闪烁
    hovered.value = -1
  }
  pickMs.value = +(performance.now() - t0).toFixed(2)

  bindFramebuffer(gl, null, ctx!.canvas.width, ctx!.canvas.height)
}

function render(now: number) {
  if (!ctx || !prog) return
  const gl = ctx!.gl
  gl.viewport(0, 0, ctx!.canvas.width, ctx!.canvas.height)

  if (idView.value && idFbo) {
    // 调试视图：直接显示 ID 颜色
    bindFramebuffer(gl, idFbo, ctx!.canvas.width, ctx!.canvas.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    drawScene(idProg!, uId, true)
    gl.disable(gl.DEPTH_TEST)
    bindFramebuffer(gl, idFbo, ctx!.canvas.width, ctx!.canvas.height)
    // 把 FBO 内容画到屏幕：直接再画一遍更省事（这里用同一个 idProg 已经画完了）
    const w = ctx!.canvas.width
    const h = ctx!.canvas.height
    bindFramebuffer(gl, null, w, h)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // 简单 blit：用一个全屏 program 采样 idFbo
    blitToScreen()
  } else {
    bindFramebuffer(gl, null, ctx!.canvas.width, ctx!.canvas.height)
    gl.enable(gl.DEPTH_TEST)
    gl.clearColor(0.03, 0.04, 0.06, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    drawScene(prog, u, false)
    gl.disable(gl.DEPTH_TEST)
  }

  if (now - lastPick > 120) {
    lastPick = now
    if (!idView.value) pick()
  }

  frames++
  if (now - lastFps > 500) {
    stats.value.fps = Math.round((frames * 1000) / (now - lastFps))
    frames = 0
    lastFps = now
  }
  raf = requestAnimationFrame(render)
}

/* ---------------- blit 用的小程序 ---------------- */
let blitProg: WebGLProgram | null = null
let blitBuf: WebGLBuffer | null = null
let blitTex: WebGLUniformLocation | null = null

function blitToScreen() {
  const gl = ctx!.gl
  if (!blitProg || !blitTex || !idFbo) return
  gl.useProgram(blitProg)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, idFbo.tex)
  gl.uniform1i(blitTex, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, blitBuf)
  const loc = gl.getAttribLocation(blitProg, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

onMounted(() => {
  if (!container.value) return
  ctx = setupGL(container.value)
  if (!ctx) return
  if (!compile()) return
  buildGeometry()
  buildObjects()

  const gl = ctx.gl
  idFbo = createFramebuffer(gl, ctx.canvas.width, ctx.canvas.height, true)
  blitProg = createProgram(
    gl,
    `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos*0.5+0.5; gl_Position=vec4(aPos,0.,1.); }`,
    `precision highp float; varying vec2 vUv; uniform sampler2D uTex; void main(){ gl_FragColor = vec4(texture2D(uTex, vUv).rgb, 1.0); }`,
  )
  blitTex = blitProg ? gl.getUniformLocation(blitProg, 'uTex') : null
  blitBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, blitBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  const cvs = ctx.canvas
  const onMove = (e: MouseEvent) => {
    const r = cvs.getBoundingClientRect()
    mouse.x = e.clientX - r.left
    mouse.y = e.clientY - r.top
    mouse.inside = mouse.x >= 0 && mouse.y >= 0 && mouse.x < r.width && mouse.y < r.height
  }
  const onLeave = () => {
    mouse.inside = false
    hovered.value = -1
  }
  const onClick = () => {
    if (hovered.value >= 0) selected.value = hovered.value
    else selected.value = -1
  }
  cvs.addEventListener('mousemove', onMove)
  cvs.addEventListener('mouseleave', onLeave)
  cvs.addEventListener('click', onClick)

  raf = requestAnimationFrame(render)

  const onResize = () => {
    ctx!.resize()
    if (idFbo) deleteFramebuffer(gl, idFbo)
    idFbo = createFramebuffer(gl, ctx!.canvas.width, ctx!.canvas.height, true)
  }
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
    cvs.removeEventListener('mousemove', onMove)
    cvs.removeEventListener('mouseleave', onLeave)
    cvs.removeEventListener('click', onClick)
  })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    deleteFramebuffer(gl, idFbo)
    for (const p of [prog, idProg, blitProg]) if (p) gl.deleteProgram(p)
    if (blitBuf) gl.deleteBuffer(blitBuf)
    for (const b of [cube.pos, cube.nrm, cube.idx]) if (b) gl.deleteBuffer(b)
  }
  ctx = null
  idFbo = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">GPU 拾取 · 颜色即 ID</div>
      <div class="sub">
        悬停 {{ hovered >= 0 ? `#${hovered}` : '—' }} · 选中 {{ selected >= 0 ? `#${selected}` : '—' }} ·
        {{ pickMs }} ms · {{ stats.fps }} fps
      </div>

      <div class="ctrl">
        <span class="lab">物体数量</span>
        <input v-model.number="count" type="range" min="40" max="400" step="20" />
        <b>{{ count }}</b>
      </div>
      <button class="chip" :class="{ on: idView }" @click="idView = !idView">
        {{ idView ? '返回正常渲染' : '查看 ID 缓冲' }}
      </button>

      <div class="tip">
        鼠标移到方块上：先把每个物体的索引编码成 RGB 渲进离屏缓冲，再 <code>readPixels</code>
        读回鼠标那一个像素，解出索引。<b>readPixels 是同步的</b>，会打断 GPU 流水线，
        所以只做 120ms 一次。悬停只更新读数，<b>点击才持久高亮</b>——否则鼠标落在方块缝隙里
        读到背景，高亮会闪。
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
  background: #06080c;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 312px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #7d8fa2;
  font-family: ui-monospace, monospace;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}
.lab {
  flex: 0 0 58px;
  font-size: 11px;
  color: #8fa0b3;
}
.ctrl input[type='range'] {
  flex: 1;
  height: 3px;
  appearance: none;
  background: rgba(96, 116, 140, 0.5);
  border-radius: 2px;
  outline: none;
}
.ctrl input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #6fb3f2;
  border: 2px solid #0e141c;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 44px;
  text-align: right;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #cfe4f5;
  font-weight: 500;
}
.chip {
  width: 100%;
  margin-top: 10px;
  padding: 5px 0;
  font-size: 11.5px;
  color: #b7c6d6;
  background: rgba(38, 50, 64, 0.9);
  border: 1px solid rgba(96, 116, 140, 0.4);
  border-radius: 6px;
  cursor: pointer;
}
.chip.on {
  color: #06121a;
  background: #6fb3f2;
  border-color: #6fb3f2;
  font-weight: 600;
}
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.24);
  font-size: 10.5px;
  line-height: 1.6;
  color: #7b8b9d;
}
.tip code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(111, 179, 242, 0.12);
  color: #9fc9f0;
  font-size: 10px;
}
</style>
