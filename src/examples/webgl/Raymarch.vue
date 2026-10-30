<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createProgram, setupGL } from './gl'

const container = ref<HTMLDivElement>()
let frames = 0
let lastTime = performance.now()
const fps = ref(0)

const VS = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FS = `
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_cam;

float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// 平滑并集：两个 SDF 用圆角过渡连起来
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float map(vec3 p) {
  vec3 q = p;
  q.xz = rot(u_time * 0.5) * q.xz;

  float ball = sdSphere(q - vec3(0.0, 0.46 + 0.12 * sin(u_time * 1.4), 0.0), 0.60);
  float ring = sdTorus(q - vec3(0.0, -0.40, 0.0), vec2(0.92, 0.20));
  float post = sdBox(q - vec3(0.0, -0.05, 0.0), vec3(0.14, 0.92, 0.14));

  float d = smin(ball, ring, 0.45);
  d = min(d, post);

  // 地面：一个无限大平面
  return min(d, p.y + 0.95);
}

// 四点采样求梯度，比 6 次 map() 便宜一半
vec3 nrm(vec3 p) {
  const vec2 e = vec2(0.0016, -0.0016);
  return normalize(
    e.xyy * map(p + e.xyy) +
    e.yyx * map(p + e.yyx) +
    e.yxy * map(p + e.yxy) +
    e.xxx * map(p + e.xxx)
  );
}

// 环境光遮蔽：沿法线方向做几次距离采样
float ao(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.02 + 0.13 * float(i) / 4.0;
    float d = map(p + n * h);
    occ += (h - d) * sca;
    sca *= 0.85;
  }
  return clamp(1.0 - 1.8 * occ, 0.0, 1.0);
}

// 软阴影：沿光线步进，记录最小的「距离/距离」比值
float shadow(vec3 ro, vec3 rd) {
  float res = 1.0;
  float t = 0.04;
  for (int i = 0; i < 28; i++) {
    float h = map(ro + rd * t);
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.02, 0.22);
    if (res < 0.008 || t > 3.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;

  vec3 ro = u_cam;
  vec3 ta = vec3(0.0, -0.05, 0.0);
  vec3 ww = normalize(ta - ro);
  vec3 uu = normalize(cross(vec3(0.0, 1.0, 0.0), ww));
  vec3 vv = cross(ww, uu);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.55 * ww);

  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);
    if (d < 0.0012) { hit = true; break; }
    t += d * 0.9;
    if (t > 9.0) break;
  }

  vec3 col;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = nrm(p);
    vec3 lig = normalize(vec3(0.62, 0.86, 0.42));

    float dif = clamp(dot(n, lig), 0.0, 1.0);
    float sha = shadow(p + n * 0.012, lig);
    float occ = ao(p, n);
    float amb = 0.42 + 0.58 * clamp(0.5 + 0.5 * n.y, 0.0, 1.0);
    float spe = pow(clamp(dot(n, normalize(lig - rd)), 0.0, 1.0), 46.0);
    float fre = pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 4.0);

    vec3 base = vec3(0.055, 0.17, 0.44);
    if (p.y < -0.93) base = vec3(0.05, 0.055, 0.07);

    col = base * (amb * 0.38 * occ + dif * sha * 0.95)
        + vec3(1.0, 0.95, 0.86) * spe * sha * 0.9
        + vec3(0.25, 0.55, 1.0) * fre * 0.22;
  } else {
    float g = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    col = mix(vec3(0.004, 0.007, 0.014), vec3(0.012, 0.028, 0.06), g);
    col += vec3(0.05, 0.10, 0.20) * pow(1.0 - abs(rd.y), 16.0);
  }

  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  gl_FragColor = vec4(col, 1.0);
}
`

onMounted(() => {
  const el = container.value
  if (!el) return
  const ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas, resize } = ctx

  const program = createProgram(gl, VS, FS)
  if (!program) return
  gl.useProgram(program)

  // 覆盖全屏的四边形
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uRes = gl.getUniformLocation(program, 'u_res')
  const uTime = gl.getUniformLocation(program, 'u_time')
  const uCam = gl.getUniformLocation(program, 'u_cam')

  gl.disable(gl.DEPTH_TEST)

  let raf = 0
  const draw = () => {
    raf = requestAnimationFrame(draw)
    gl.viewport(0, 0, canvas.width, canvas.height)

    const t = performance.now() / 1000
    gl.uniform2f(uRes, canvas.width, canvas.height)
    gl.uniform1f(uTime, t)
    gl.uniform3f(
      uCam,
      Math.cos(t * 0.32) * 5.2,
      1.35 + 0.35 * Math.sin(t * 0.47),
      Math.sin(t * 0.32) * 5.2,
    )

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    frames++
    const now = performance.now()
    if (now - lastTime > 500) {
      fps.value = Math.round((frames * 1000) / (now - lastTime))
      frames = 0
      lastTime = now
    }
  }
  draw()

  const onResize = () => resize()
  window.addEventListener('resize', onResize)

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    gl.deleteBuffer(vbo)
    gl.deleteProgram(program)
    canvas.remove()
  })
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="head">
        <span class="title">SDF 光线步进</span>
        <span class="fps">{{ fps }} FPS</span>
      </div>
      <div class="tags">
        <span class="tag">sphere</span>
        <span class="tag">torus</span>
        <span class="tag">box</span>
        <span class="tag">smin</span>
      </div>
      <div class="tip">
        整个画面只有一个全屏四边形：片元着色器对每个像素从相机发射射线，沿距离场步进求交，
        再用四点梯度求法线、软阴影与环境光遮蔽。
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
  background: rgba(9, 14, 21, 0.8);
  border: 1px solid rgba(90, 110, 135, 0.42);
  backdrop-filter: blur(8px);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e6eef7;
}
.fps {
  font-size: 11px;
  color: #7ee787;
}
.tags {
  display: flex;
  gap: 6px;
  margin-top: 7px;
}
.tag {
  padding: 1px 7px;
  border-radius: 5px;
  background: rgba(79, 157, 255, 0.14);
  border: 1px solid rgba(79, 157, 255, 0.32);
  color: #8ec4ff;
  font-size: 10.5px;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.55;
  color: #8b9aab;
}
</style>
