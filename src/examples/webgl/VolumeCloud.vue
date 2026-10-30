<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* ============================================================
 * 体积云 · 光线步进（WebGL2）
 *  - 3D 值噪声 fBm 生成 64³ 体积纹理（R8，程序化、周期无缝）
 *  - 相机射线与云盒 AABB 求交，盒内固定步长步进
 *  - 每一步向太阳方向二次步进，Beer-Lambert 透射 + HG 相位函数
 *  - 前向 alpha 合成，最后 ACES 色调映射 + gamma
 * ============================================================ */

const container = ref<HTMLDivElement>()
const coverage = ref(0.54)
const density = ref(1.1)
const sunAlt = ref(16)
const quality = ref(56)
const autoOrbit = ref(true)
const loading = ref(true)
const fps = ref(0)

let raf = 0
let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let vao: WebGLVertexArrayObject | null = null
let noiseTex: WebGLTexture | null = null
let canvas: HTMLCanvasElement | null = null

/** 相机状态 */
let yaw = 0.55
let pitch = -0.26
let camY = 2.2
let dragging = false
let lastX = 0
let lastY = 0
const cleanups: Array<() => void> = []

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  cleanups.forEach((fn) => fn())
  cleanups.length = 0
  if (gl) {
    if (program) gl.deleteProgram(program)
    if (vao) gl.deleteVertexArray(vao)
    if (noiseTex) gl.deleteTexture(noiseTex)
  }
})

/* ============================================================
 * 程序化 3D 噪声纹理
 * ============================================================ */

/** 32 位整数哈希 → [0,1)，按 period 取模保证纹理可无缝平铺 */
function hash3(x: number, y: number, z: number, period: number): number {
  const xi = ((x % period) + period) % period
  const yi = ((y % period) + period) % period
  const zi = ((z % period) + period) % period
  let h = (xi * 374761393 + yi * 668265263 + zi * 1274126177) | 0
  h = (h ^ (h >>> 13)) | 0
  h = Math.imul(h, 1274126177) | 0
  h = (h ^ (h >>> 16)) | 0
  return (h >>> 0) / 4294967296
}

/** 三线性插值的值噪声（坐标以「格」为单位） */
function vnoise(x: number, y: number, z: number, period: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const fx = x - xi
  const fy = y - yi
  const fz = z - zi
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const uz = fz * fz * (3 - 2 * fz)

  const c000 = hash3(xi, yi, zi, period)
  const c100 = hash3(xi + 1, yi, zi, period)
  const c010 = hash3(xi, yi + 1, zi, period)
  const c110 = hash3(xi + 1, yi + 1, zi, period)
  const c001 = hash3(xi, yi, zi + 1, period)
  const c101 = hash3(xi + 1, yi, zi + 1, period)
  const c011 = hash3(xi, yi + 1, zi + 1, period)
  const c111 = hash3(xi + 1, yi + 1, zi + 1, period)

  const x00 = c000 + (c100 - c000) * ux
  const x10 = c010 + (c110 - c010) * ux
  const x01 = c001 + (c101 - c001) * ux
  const x11 = c011 + (c111 - c011) * ux
  const y0 = x00 + (x10 - x00) * uy
  const y1 = x01 + (x11 - x01) * uy
  return y0 + (y1 - y0) * uz
}

/** 生成 64³ 单通道体积噪声（fBm，低频大团 + 高频细节） */
function buildNoise(N: number): Uint8Array {
  const data = new Uint8Array(N * N * N)
  const octaves = [
    { freq: 3, amp: 0.62 },
    { freq: 6, amp: 0.26 },
    { freq: 12, amp: 0.12 },
  ]
  let ptr = 0
  for (let z = 0; z < N; z++) {
    const wz = (z / N) * 4
    for (let y = 0; y < N; y++) {
      const wy = (y / N) * 4
      for (let x = 0; x < N; x++) {
        const wx = (x / N) * 4
        let v = 0
        for (const o of octaves) {
          v += vnoise(wx * o.freq, wy * o.freq, wz * o.freq, o.freq * 4) * o.amp
        }
        // 拉开对比度，让云团边界更清晰
        v = Math.pow(Math.min(1, Math.max(0, v)), 1.35)
        data[ptr++] = (v * 255) | 0
      }
    }
  }
  return data
}

/* ============================================================
 * 着色器
 * ============================================================ */
const VS = `#version 300 es
void main() {
  // 用 gl_VertexID 生成覆盖全屏的大三角形，无需顶点缓冲
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;

out vec4 outColor;

uniform vec2  uRes;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform vec3  uSunDir;
uniform float uTime;
uniform float uCoverage;
uniform float uSigma;
uniform int   uSteps;
uniform sampler3D uNoise;

// 云海水平方向近似无限：世界坐标周期采样 + 行进距离截断
const vec3 BOX_MIN = vec3(-60.0, 0.0, -60.0);
const vec3 BOX_MAX = vec3( 60.0, 1.9, 60.0);
const float MAX_DIST = 19.0;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** 云密度场：0..1，p 为世界坐标 */
float cloudDensity(vec3 p) {
  if (p.y < BOX_MIN.y || p.y > BOX_MAX.y) return 0.0;

  vec3 q = vec3(p.x * 0.052, p.y / BOX_MAX.y, p.z * 0.052);
  vec3 wind = vec3(uTime * 0.004, 0.0, uTime * 0.006);

  float base   = texture(uNoise, q + wind).r;
  float detail = texture(uNoise, q * 2.6 - wind * 1.7).r;
  float shape = base * 0.72 + detail * 0.28;

  // 高度廓线：低频噪声扰动高度，云顶因此有起伏而不是一张平板
  float hq = clamp(p.y / BOX_MAX.y + (base - 0.5) * 0.42, 0.0, 1.0);
  float grad = smoothstep(0.0, 0.1, hq) * (1.0 - smoothstep(0.55, 1.0, hq));

  float d = clamp((shape - (1.0 - uCoverage)) * 3.2, 0.0, 1.0);
  d = d * d * (3.0 - 2.0 * d);
  return clamp(d * grad, 0.0, 1.0);
}

/** 沿太阳方向二次步进，返回透射率（步长固定，才能体现云体内部的自阴影） */
float lightMarch(vec3 p) {
  const float LS = 0.2;
  float acc = 0.0;
  vec3 q = p;
  for (int i = 0; i < 6; i++) {
    q += uSunDir * LS;
    acc += cloudDensity(q);
  }
  return exp(-acc * LS * uSigma * 3.4);
}

/** Henyey-Greenstein 相位函数 */
float hg(float cosA, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * cosA, 1.5));
}

bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 a = (BOX_MIN - ro) * inv;
  vec3 b = (BOX_MAX - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z);
  t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}

vec3 skyColor(vec3 rd) {
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 zenith = vec3(0.020, 0.048, 0.135);
  vec3 mid    = vec3(0.075, 0.145, 0.31);
  vec3 horizon= vec3(0.26, 0.31, 0.44);
  vec3 c = mix(horizon, mid, smoothstep(0.42, 0.56, h));
  c = mix(c, zenith, smoothstep(0.55, 0.98, h));

  float s = max(dot(rd, uSunDir), 0.0);
  c += vec3(1.0, 0.72, 0.40) * pow(s, 6.0) * 0.34;      // 大范围晨昏光晕
  c += vec3(1.0, 0.86, 0.62) * pow(s, 220.0) * 3.2;     // 太阳本体
  return c;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 rd = normalize(uCamFwd + uCamRight * uv.x + uCamUp * uv.y);
  vec3 ro = uCamPos;

  vec3 col = skyColor(rd);

  float t0, t1;
  if (boxHit(ro, rd, t0, t1)) {
    float start = max(t0, 0.0);
    float span = min(t1 - start, MAX_DIST);
    float steps = float(uSteps);
    float dt = span / steps;

    // 蓝噪声式的逐像素抖动，消除步进条纹
    float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 91.7);
    float t = start + dt * jitter;

    vec3 acc = vec3(0.0);
    float trans = 1.0;
    float cosA = dot(rd, uSunDir);
    float phase = (hg(cosA, 0.55) + hg(cosA, -0.2) * 0.4) * 3.0;

    for (int i = 0; i < 128; i++) {
      if (float(i) >= steps || trans < 0.02) break;
      vec3 p = ro + rd * t;
      float d = cloudDensity(p);
      if (d > 0.002) {
        float lt = lightMarch(p);
        // 多次散射近似：向阳面偏白，背光面偏冷蓝
        float hy = clamp(p.y / BOX_MAX.y, 0.0, 1.0);
        vec3 sunCol = vec3(1.0, 0.88, 0.70) * 4.3;
        vec3 ambCol = vec3(0.17, 0.27, 0.46) * (0.26 + 0.5 * hy);
        float powder = 1.0 - exp(-d * 4.0);
        vec3 lum = sunCol * lt * phase * powder + ambCol * (0.40 + 0.45 * d);

        float a = 1.0 - exp(-d * uSigma * dt * 12.0);
        acc += trans * lum * a;
        trans *= 1.0 - a;
      }
      t += dt;
    }
    col = col * trans + acc;
  }

  // ACES 近似色调映射
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}`

/* ============================================================
 * 初始化
 * ============================================================ */
function initGL(el: HTMLDivElement): boolean {
  canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const ctx = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    powerPreference: 'high-performance',
  })
  if (!ctx) {
    el.innerHTML = '<div style="color:#93a5b8;padding:24px;font:13px sans-serif">当前浏览器不支持 WebGL2</div>'
    return false
  }
  gl = ctx

  const makeShader = (type: number, src: string) => {
    const sh = gl!.createShader(type)!
    gl!.shaderSource(sh, src)
    gl!.compileShader(sh)
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
      console.error('着色器编译失败：', gl!.getShaderInfoLog(sh))
      return null
    }
    return sh
  }

  const vs = makeShader(gl.VERTEX_SHADER, VS)
  const fs = makeShader(gl.FRAGMENT_SHADER, FS)
  if (!vs || !fs) return false

  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('程序链接失败：', gl.getProgramInfoLog(prog))
    return false
  }
  program = prog
  vao = gl.createVertexArray()
  return true
}

function uploadNoise(N: number) {
  if (!gl) return
  const data = buildNoise(N)
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.R8,
    N,
    N,
    N,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    data,
  )
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT)
  noiseTex = tex
}

/* ============================================================
 * 渲染循环
 * ============================================================ */
function start(el: HTMLDivElement) {
  if (!gl || !program || !vao) return
  const g = gl
  const prog = program

  const uni = {
    res: g.getUniformLocation(prog, 'uRes')!,
    camPos: g.getUniformLocation(prog, 'uCamPos')!,
    right: g.getUniformLocation(prog, 'uCamRight')!,
    up: g.getUniformLocation(prog, 'uCamUp')!,
    fwd: g.getUniformLocation(prog, 'uCamFwd')!,
    sun: g.getUniformLocation(prog, 'uSunDir')!,
    time: g.getUniformLocation(prog, 'uTime')!,
    coverage: g.getUniformLocation(prog, 'uCoverage')!,
    sigma: g.getUniformLocation(prog, 'uSigma')!,
    steps: g.getUniformLocation(prog, 'uSteps')!,
    noise: g.getUniformLocation(prog, 'uNoise')!,
  }

  // 诊断：确认所有 uniform 都拿到 location
  const missing = Object.entries(uni).filter(([, v]) => v === null).map(([k]) => k)
  if (missing.length) console.error('uniform location 缺失：', missing.join(','))

  let last = performance.now()
  let acc = 0
  let frames = 0

  const frame = () => {
    raf = requestAnimationFrame(frame)
    const now = performance.now()
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now

    // FPS 统计
    acc += dt
    frames++
    if (acc > 0.5) {
      fps.value = Math.round(frames / acc)
      acc = 0
      frames = 0
    }

    // 尺寸（体积云按 0.72 倍分辨率渲染，再拉伸铺满）
    const dpr = 0.72
    const w = Math.max(1, Math.floor((el.clientWidth || 1) * dpr))
    const h = Math.max(1, Math.floor((el.clientHeight || 1) * dpr))
    if (canvas && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w
      canvas.height = h
    }
    g.viewport(0, 0, w, h)

    if (autoOrbit.value && !dragging) yaw += dt * 0.045

    // 相机基向量
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const fwd: [number, number, number] = [sy * cp, sp, -cy * cp]
    const right: [number, number, number] = [cy, 0, sy]
    const up: [number, number, number] = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ]

    const alt = (sunAlt.value * Math.PI) / 180
    const sunDir: [number, number, number] = [
      Math.cos(alt) * 0.78,
      Math.sin(alt),
      Math.cos(alt) * 0.62,
    ]

    g.useProgram(prog)
    g.bindVertexArray(vao)
    g.uniform2f(uni.res, w, h)
    g.uniform3f(uni.camPos, 0, camY, 0)
    g.uniform3f(uni.right, right[0], right[1], right[2])
    g.uniform3f(uni.up, up[0], up[1], up[2])
    g.uniform3f(uni.fwd, fwd[0], fwd[1], fwd[2])
    g.uniform3f(uni.sun, sunDir[0], sunDir[1], sunDir[2])
    g.uniform1f(uni.time, now / 1000)
    g.uniform1f(uni.coverage, coverage.value)
    g.uniform1f(uni.sigma, density.value)
    g.uniform1i(uni.steps, quality.value)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_3D, noiseTex)
    g.uniform1i(uni.noise, 0)
    g.drawArrays(g.TRIANGLES, 0, 3)
  }
  frame()
}

/* ============================================================
 * 交互
 * ============================================================ */
function bindPointer(el: HTMLDivElement) {
  const down = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    el.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!dragging) return
    yaw -= (e.clientX - lastX) * 0.005
    pitch = Math.max(-0.85, Math.min(0.7, pitch - (e.clientY - lastY) * 0.004))
    lastX = e.clientX
    lastY = e.clientY
  }
  const up = (e: PointerEvent) => {
    dragging = false
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    camY = Math.max(0.35, Math.min(3.6, camY + e.deltaY * 0.0018))
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('wheel', wheel, { passive: false })
  cleanups.push(() => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.removeEventListener('wheel', wheel)
  })
}

onMounted(() => {
  const el = container.value
  if (!el) return
  if (!initGL(el)) return
  bindPointer(el)
  // 噪声生成会阻塞 ~200ms，先让 loading 状态渲染出来
  setTimeout(() => {
    uploadNoise(48)
    loading.value = false
    start(el)
  }, 40)
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>

    <div v-if="loading" class="loading">正在生成 48³ 体积噪声…</div>

    <div class="hud">
      <span class="fps">{{ fps }} FPS</span>
      <span class="dot">·</span>
      <span>{{ quality }} 步</span>
    </div>

    <div class="panel">
      <div class="title">体积云 · 光线步进</div>
      <div class="sub">拖拽旋转视角 · 滚轮升降高度</div>

      <div class="ctrl">
        <span class="lab">云量</span>
        <input v-model.number="coverage" type="range" min="0.2" max="0.82" step="0.01" />
        <b>{{ Math.round(coverage * 100) }}%</b>
      </div>
      <div class="ctrl">
        <span class="lab">浓度</span>
        <input v-model.number="density" type="range" min="0.4" max="2.4" step="0.05" />
        <b>{{ density.toFixed(1) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">太阳</span>
        <input v-model.number="sunAlt" type="range" min="-4" max="48" step="1" />
        <b>{{ sunAlt }}°</b>
      </div>
      <div class="ctrl">
        <span class="lab">精度</span>
        <input v-model.number="quality" type="range" min="24" max="112" step="4" />
        <b>{{ quality }}</b>
      </div>

      <label class="check">
        <input v-model="autoOrbit" type="checkbox" />
        <span>自动巡航</span>
      </label>

      <div class="tip">
        每像素沿视线步进穿过云盒，命中后向太阳方向再做 5 次二次步进累计光学厚度，
        用 Beer–Lambert 求透射率，配合 Henyey–Greenstein 相位函数得到前向散射的银边。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0b1018;
}
.gl-container {
  width: 100%;
  height: 100%;
  cursor: grab;
}
.gl-container:active {
  cursor: grabbing;
}
.loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9db0c4;
  font-size: 13px;
  letter-spacing: 0.4px;
  background: #0b1018;
  z-index: 8;
}
.hud {
  position: absolute;
  top: 14px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 11px;
  color: #a9bccf;
  border-radius: 7px;
  background: rgba(12, 18, 26, 0.6);
  border: 1px solid rgba(90, 110, 134, 0.3);
  backdrop-filter: blur(6px);
  font-variant-numeric: tabular-nums;
}
.fps {
  color: #7ee787;
  font-weight: 600;
}
.dot {
  color: #4a5a6a;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 286px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.78);
  border: 1px solid rgba(88, 108, 132, 0.4);
  color: #d7e2ee;
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.sub {
  margin-top: 3px;
  font-size: 11px;
  color: #7d8fa2;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
  color: #93a5b8;
}
.ctrl .lab {
  width: 28px;
  flex: none;
}
.ctrl input {
  flex: 1;
  height: 3px;
  accent-color: #61b6ff;
}
.ctrl b {
  width: 40px;
  text-align: right;
  color: #cfe0f2;
  font-variant-numeric: tabular-nums;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 11.5px;
  color: #a9bccf;
  cursor: pointer;
}
.check input {
  accent-color: #61b6ff;
}
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.26);
  font-size: 10.6px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
