<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  createCube,
  createProgram,
  createSphere,
  perspective,
  setupGL,
  type GLContext,
} from './gl'

/* ============================================================
 * 原生阴影贴图（Shadow Mapping）
 *  1) 光空间 pass：把场景渲到 1024² 的 FBO，片元把「线性化的深度」打包进 RGBA8
 *     —— 不依赖 WEBGL_depth_texture（WebGL1 里要不要都行），24 位精度足够
 *  2) 主 pass：把片元的世界坐标变换到光空间，取 [0,1] 的深度再解包比对，
 *     采样点在前则受光，否则在阴影里
 *  3) 常见的两个坑：自阴影摩尔纹（ acne）用 slope-scaled bias + 法线偏移压住；
 *     采样点不足导致的硬边 incontinuity用 3×3 PCF 九宫格平均软化
 * ============================================================ */

const container = ref<HTMLDivElement>()
let raf = 0
let ctx: GLContext | null = null
let resizeFn: (() => void) | null = null

const SHADOW_SIZE = 1024
/** 光源正交视锥：光源距原点约 33，场景半径约 24，取 [-0, 70] 保证全部包住 */
const L = { fwd: 0, back: 70, half: 30 }

/* ---------------- 参数 ---------------- */
const lightAngle = ref(38) // 光源方位角（度）
const bias = ref(0.0035) // 深度比较偏移
const pcfRadius = ref(1.6) // PCF 采样半径（纹素）
const autoSpin = ref(true)
const showMap = ref(false)

/* ---------------- 着色器：深度 pass ---------------- */
const depthVs = /* glsl */ `
attribute vec3 aPos;
uniform mat4 uLightProj;
uniform mat4 uLightView;
uniform mat4 uModel;
varying float vDepth;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 lp = uLightProj * uLightView * world;
  // 线性深度：光空间是正交投影，可以直接用 view 空间 z 归一化，避免透视带来的精度分布问题
  vec4 eye = uLightView * world;
  vDepth = clamp((-eye.z - ${L.fwd.toFixed(1)}) / ${(L.back - L.fwd).toFixed(1)}, 0.0, 1.0);
  gl_Position = lp;
}
`

const depthFs = /* glsl */ `
precision highp float;
varying float vDepth;

// 把一个 [0,1] 的浮点数打包进 RGBA8（24 位有效精度）
vec4 packDepth(float v) {
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return enc;
}

void main() {
  gl_FragColor = packDepth(vDepth);
}
`

/* ---------------- 着色器：主 pass ---------------- */
const mainVs = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vWorld;
varying vec3 vNormal;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  gl_Position = uProj * uView * world;
}
`

const mainFs = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;

uniform mat4 uLightProj;
uniform mat4 uLightView;
uniform sampler2D uShadowMap;
uniform vec3 uLightPos;
uniform vec3 uEye;
uniform vec3 uColor;
uniform float uBias;
uniform float uPcfRadius;
uniform float uTexel;
uniform float uGround;

float unpackDepth(vec4 rgba) {
  return dot(rgba, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

/** 一次深度取样：返回 1（受光）/ 0（阴影） */
float sampleShadow(vec2 uv, float ref) {
  vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
  if (c.x != uv.x || c.y != uv.y) return 1.0; // 出了光锥直接算受光
  float d = unpackDepth(texture2D(uShadowMap, c));
  return ref - uBias > d ? 0.0 : 1.0;
}

/** 3×3 PCF：九次取样平均，硬边被磨成柔和的半影 */
float pcf(vec2 uv, float ref) {
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += sampleShadow(uv + vec2(float(x), float(y)) * uTexel * uPcfRadius, ref);
    }
  }
  return sum / 9.0;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 Ldir = normalize(uLightPos - vWorld);
  vec3 V = normalize(uEye - vWorld);

  // 只有朝向光源的面才可能因自遮挡产生 acne，背光面直接跳过阴影比较
  float facing = dot(N, Ldir);

  // 世界坐标 → 光空间，得到参与比对的参考深度
  vec4 eye = uLightView * vec4(vWorld, 1.0);
  float ref = clamp((-eye.z - ${L.fwd.toFixed(1)}) / ${(L.back - L.fwd).toFixed(1)}, 0.0, 1.0);

  // 法线方向偏移采样点：等价于 slope-scaled bias，比单纯加常量更能压住斜面上的条纹
  vec3 nOff = N * (0.02 + 0.06 * (1.0 - max(facing, 0.0)));
  vec4 op = uLightProj * uLightView * vec4(vWorld + nOff, 1.0);
  vec2 ouv = (op.xyz / op.w).xy * 0.5 + 0.5;

  float shadow = facing <= 0.0 ? 0.0 : pcf(ouv, ref);

  // 半兰伯特，背光面不至于死黑
  float diff = max(facing, 0.0);
  vec3 H = normalize(Ldir + V);
  float spec = pow(max(dot(N, H), 0.0), 48.0) * shadow;

  // 棋盘格地面：让落到地面上的投影边界看得更清楚
  float checker = 1.0;
  if (uGround > 0.5) {
    float c = mod(floor(vWorld.x * 0.5) + floor(vWorld.z * 0.5), 2.0);
    checker = mix(0.72, 1.0, c);
  }

  vec3 ambient = uColor * 0.16;
  vec3 lit = uColor * (diff * shadow * 0.85 + 0.15) * checker;
  vec3 color = ambient + lit + vec3(1.0) * spec * 0.5;

  // Reinhard 色调映射 + gamma
  color = color / (color + vec3(1.0));
  gl_FragColor = vec4(pow(color, vec3(1.0 / 2.2)), 1.0);
}
`

/* ---------------- 小面片：把深度图叠在角上---------------- */
const quadVs = /* glsl */ `
attribute vec2 aQuad;
varying vec2 vUv;
void main() {
  vUv = aQuad * 0.5 + 0.5;
  gl_Position = vec4(aQuad * 0.42 + vec2(0.55, 0.55), 0.0, 1.0);
}
`
const quadFs = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uShadowMap;
float unpackDepth(vec4 rgba) {
  return dot(rgba, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
void main() {
  float d = unpackDepth(texture2D(uShadowMap, vUv));
  gl_FragColor = vec4(vec3(1.0 - d), 1.0);
}
`

/* ---------------- 矩阵：正交/视图 ---------------- */
type Mat4 = Float32Array
function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  return new Float32Array([
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ])
}
function lookAtM(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number] = [0, 1, 0],
): Mat4 {
  let zx = eye[0] - center[0]
  let zy = eye[1] - center[1]
  let zz = eye[2] - center[2]
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len
  zy /= len
  zz /= len
  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  len = Math.hypot(xx, xy, xz) || 1
  xx /= len
  xy /= len
  xz /= len
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ])
}
function normalMat3(m: Mat4): Float32Array {
  return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
}

/** 模型矩阵：绕 Y 旋转 + 非等比缩放 + 平移（本例只有这三类变换，直接手推即可） */
function modelMat(
  pos: [number, number, number],
  rotY: number,
  sx: number,
  sy: number,
  sz: number,
): Mat4 {
  const c = Math.cos(rotY)
  const s = Math.sin(rotY)
  return new Float32Array([
    c * sx, 0, -s * sx, 0,
    0, sy, 0, 0,
    s * sz, 0, c * sz, 0,
    pos[0], pos[1], pos[2], 1,
  ])
}

interface MeshGeo {
  positions: Float32Array
  normals: Float32Array
  indices: Uint16Array
}
interface Draw {
  geo: MeshGeo
  color: [number, number, number]
  pos: [number, number, number]
  scale: [number, number, number]
  rot: number
  spin: number
  ground?: boolean
}

function makeTorus(R = 1, r = 0.34, seg = 48, side = 20): MeshGeo {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= seg; i++) {
    const u = (i / seg) * Math.PI * 2
    for (let j = 0; j <= side; j++) {
      const v = (j / side) * Math.PI * 2
      const cx = Math.cos(u) * R
      const cz = Math.sin(u) * R
      const nx = Math.cos(u) * Math.cos(v)
      const ny = Math.sin(v)
      const nz = Math.sin(u) * Math.cos(v)
      positions.push(cx + nx * r, ny * r, cz + nz * r)
      normals.push(nx, ny, nz)
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < side; j++) {
      const a = i * (side + 1) + j
      const b = a + side + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  }
}

onMounted(() => {
  const el = container.value
  if (!el) return
  ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas } = ctx
  resizeFn = () => ctx?.resize()
  window.addEventListener('resize', resizeFn!)

  const depthProg = createProgram(gl, depthVs, depthFs)
  const mainProg = createProgram(gl, mainVs, mainFs)
  const quadProg = createProgram(gl, quadVs, quadFs)
  if (!depthProg || !mainProg || !quadProg) return

  /* ---- 阴影 FBO：RGBA8 颜色 + 16 位深度附件 ---- */
  const shadowTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, shadowTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHADOW_SIZE, SHADOW_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST) // PCF 手动取样，用 NEAREST 才准
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const depthRb = gl.createRenderbuffer()
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb)
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, SHADOW_SIZE, SHADOW_SIZE)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shadowTex, 0)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('阴影 FBO 不完整')
    return
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  /* ---- 几何 ---- */
  const cube = createCube()
  const sphere = createSphere(40, 24)
  const torus = makeTorus()

  const draws: Draw[] = [
    // 地面：单位立方体压成一薄板（顶面对齐 y=0）
    {
      geo: cube,
      color: [0.55, 0.6, 0.68],
      pos: [0, -0.3, 0],
      scale: [13, 0.3, 13],
      rot: 0,
      spin: 0,
      ground: true,
    },
    { geo: sphere, color: [0.86, 0.42, 0.34], pos: [-3.1, 1.1, -1.4], scale: [1.1, 1.1, 1.1], rot: 0, spin: 0.35 },
    { geo: cube, color: [0.4, 0.78, 0.6], pos: [2.6, 0.75, -2.2], scale: [0.75, 0.75, 0.75], rot: 0.6, spin: 0.2 },
    { geo: torus, color: [0.92, 0.78, 0.32], pos: [0.4, 1.5, 2.2], scale: [0.9, 0.9, 0.9], rot: 0.2, spin: 0.5 },
    { geo: sphere, color: [0.62, 0.5, 0.9], pos: [-1.2, 0.5, 3.4], scale: [0.5, 0.5, 0.5], rot: 0, spin: 0.4 },
    { geo: cube, color: [0.5, 0.7, 0.9], pos: [4.2, 0.45, 1.6], scale: [0.45, 0.45, 0.45], rot: 0.3, spin: 0.3 },
  ]

  // 每个几何体一份 VAO（用 WebGL1 的手写绑定换取可读性）
  const vbos = draws.map((d) => {
    const pb = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, pb)
    gl.bufferData(gl.ARRAY_BUFFER, d.geo.positions, gl.STATIC_DRAW)
    const nb = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, nb)
    gl.bufferData(gl.ARRAY_BUFFER, d.geo.normals, gl.STATIC_DRAW)
    const ib = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.geo.indices, gl.STATIC_DRAW)
    return { pb, nb, ib }
  })

  const quadBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  function bindGeo(i: number, posLoc: number, normalLoc: number) {
    const { pb, nb, ib } = vbos[i]
    gl.bindBuffer(gl.ARRAY_BUFFER, pb)
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0)
    if (normalLoc >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, nb)
      gl.enableVertexAttribArray(normalLoc)
      gl.vertexAttribPointer(normalLoc, 3, gl.FLOAT, false, 0, 0)
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib)
  }

  // 视图：拖拽画面横向移动 → 改变绕 Y 轴的视角
  // （yaw 由指针事件更新，或按 autoSpin 自动巡视）
  let yaw = 0
  let dragging = false
  let lastX = 0
  function onDown(e: PointerEvent) {
    dragging = true
    lastX = e.clientX
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return
    yaw += (e.clientX - lastX) * 0.006
    lastX = e.clientX
  }
  function onUp() {
    dragging = false
  }
  canvas.addEventListener('pointerdown', onDown)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)

  const texel = 1 / SHADOW_SIZE

  const render = (now: number) => {
    raf = requestAnimationFrame(render)
    const t = now / 1000
    if (autoSpin.value) yaw = t * 0.16

    // 相机绕原点环绕（保持高度与半径）
    const rad = 15.5
    const camY = 7.2
    const eye: [number, number, number] = [
      Math.sin(yaw) * rad,
      camY,
      Math.cos(yaw) * rad,
    ]

    // 光源：绕 Y 轴旋转的方向光
    const la = (lightAngle.value * Math.PI) / 180
    const lightDir: [number, number, number] = [Math.sin(la), -1.25, Math.cos(la)]
    const lightPos: [number, number, number] = [
      lightDir[0] * 18,
      -lightDir[1] * 18,
      lightDir[2] * 18,
    ]
    // 光空间：正交投影 + 从光源看向原点
    const lightView = lookAtM(lightPos, [0, 0, 0])
    const lightProj = ortho(-L.half, L.half, -L.half, L.half, L.fwd, L.back)

    const proj = perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 200)
    const view = lookAtM(eye, [0, 1.6, 0])

    const anim: Array<[number, number, number]> = draws.map((d, i) => [
      d.pos[0],
      d.pos[1] + (d.ground ? 0 : Math.sin(t * 0.9 + i) * 0.16),
      d.pos[2],
    ])

    /* ---- pass 1：深度图 ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE)
    gl.clearColor(1, 1, 1, 1) // 无遮挡处的「最远」值：pack(1) = 白
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.useProgram(depthProg)
    const dPos = gl.getAttribLocation(depthProg, 'aPos')
    const duLP = gl.getUniformLocation(depthProg, 'uLightProj')
    const duLV = gl.getUniformLocation(depthProg, 'uLightView')
    const duMod = gl.getUniformLocation(depthProg, 'uModel')
    gl.uniformMatrix4fv(duLP, false, lightProj)
    gl.uniformMatrix4fv(duLV, false, lightView)
    draws.forEach((d, i) => {
      const m = modelMat(anim[i], d.rot + t * d.spin, d.scale[0], d.scale[1], d.scale[2])
      gl.uniformMatrix4fv(duMod, false, m)
      bindGeo(i, dPos, -1)
      gl.drawElements(gl.TRIANGLES, d.geo.indices.length, gl.UNSIGNED_SHORT, 0)
    })

    /* ---- pass 2：主场景 ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0.055, 0.07, 0.095, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(mainProg)
    const mPos = gl.getAttribLocation(mainProg, 'aPos')
    const mNorm = gl.getAttribLocation(mainProg, 'aNormal')
    const muProj = gl.getUniformLocation(mainProg, 'uProj')
    const muView = gl.getUniformLocation(mainProg, 'uView')
    const muMod = gl.getUniformLocation(mainProg, 'uModel')
    const muNM = gl.getUniformLocation(mainProg, 'uNormalMat')
    const muLP = gl.getUniformLocation(mainProg, 'uLightProj')
    const muLV = gl.getUniformLocation(mainProg, 'uLightView')
    const muMap = gl.getUniformLocation(mainProg, 'uShadowMap')
    const muLPos = gl.getUniformLocation(mainProg, 'uLightPos')
    const muEye = gl.getUniformLocation(mainProg, 'uEye')
    const muColor = gl.getUniformLocation(mainProg, 'uColor')
    const muBias = gl.getUniformLocation(mainProg, 'uBias')
    const muPcf = gl.getUniformLocation(mainProg, 'uPcfRadius')
    const muTexel = gl.getUniformLocation(mainProg, 'uTexel')
    const muGround = gl.getUniformLocation(mainProg, 'uGround')

    gl.uniformMatrix4fv(muProj, false, proj)
    gl.uniformMatrix4fv(muView, false, view)
    gl.uniformMatrix4fv(muLP, false, lightProj)
    gl.uniformMatrix4fv(muLV, false, lightView)
    gl.uniform3fv(muLPos, lightPos)
    gl.uniform3fv(muEye, eye)
    gl.uniform1f(muBias, bias.value)
    gl.uniform1f(muPcf, pcfRadius.value)
    gl.uniform1f(muTexel, texel)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, shadowTex)
    gl.uniform1i(muMap, 0)

    draws.forEach((d, i) => {
      const m = modelMat(anim[i], d.rot + t * d.spin, d.scale[0], d.scale[1], d.scale[2])
      gl.uniformMatrix4fv(muMod, false, m)
      gl.uniformMatrix3fv(muNM, false, normalMat3(m))
      gl.uniform3fv(muColor, d.color)
      gl.uniform1f(muGround, d.ground ? 1 : 0)
      bindGeo(i, mPos, mNorm)
      gl.drawElements(gl.TRIANGLES, d.geo.indices.length, gl.UNSIGNED_SHORT, 0)
    })

    /* ---- 角标：把深度图叠上去看看是什么样 ---- */
    if (showMap.value) {
      gl.disable(gl.DEPTH_TEST)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.useProgram(quadProg)
      const q = gl.getAttribLocation(quadProg, 'aQuad')
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.enableVertexAttribArray(q)
      gl.vertexAttribPointer(q, 2, gl.FLOAT, false, 0, 0)
      gl.uniform1i(gl.getUniformLocation(quadProg, 'uShadowMap'), 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.disable(gl.BLEND)
      gl.enable(gl.DEPTH_TEST)
    }
  }
  raf = requestAnimationFrame(render)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (resizeFn) window.removeEventListener('resize', resizeFn)
  ctx?.gl?.getExtension('WEBGL_lose_context')?.loseContext()
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="title">阴影贴图 · Shadow Mapping</div>
      <div class="row">
        <span class="label">光源方位</span>
        <input v-model.number="lightAngle" class="range" type="range" min="0" max="360" step="1" />
        <span class="val">{{ lightAngle }}°</span>
      </div>
      <div class="row">
        <span class="label">深度偏移</span>
        <input v-model.number="bias" class="range" type="range" min="0" max="0.02" step="0.0005" />
        <span class="val">{{ bias.toFixed(4) }}</span>
      </div>
      <div class="row">
        <span class="label">PCF 半径</span>
        <input v-model.number="pcfRadius" class="range" type="range" min="0" max="5" step="0.1" />
        <span class="val">{{ pcfRadius.toFixed(1) }}</span>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: autoSpin }" @click="autoSpin = !autoSpin">
          {{ autoSpin ? '停止巡视' : '自动巡视' }}
        </button>
        <button class="chip" :class="{ on: showMap }" @click="showMap = !showMap">深度图角标</button>
      </div>
      <div class="tip">
        拖拽画面可绕 Y 轴环视。两个 pass：光空间渲染把「线性深度」打包进 RGBA8（不依赖
        深度纹理扩展），主 pass 解包后与参考深度比对，再用 3×3 PCF 软化边缘；
        把深度偏移调大能看到自阴影条纹（acne）如何被压住，把 PCF 半径调大则影子边缘变柔。
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
  width: 336px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
  margin-bottom: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
  flex: 0 0 62px;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 52px;
  text-align: right;
}
.btns {
  gap: 7px;
}
.chip {
  padding: 5px 9px;
  font-size: 11px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  cursor: pointer;
}
.chip.on {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #8b9aab;
}
</style>
