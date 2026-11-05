<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const autoPlay = ref(true)
const materialRef = shallowRef<THREE.ShaderMaterial | null>(null)
const phaseLabel = ref('文字')

/**
 * 粒子变形（创意网站常见的 image/text ↔ geometry morph，手写实现）：
 * - 三组目标位置各存一个 attribute：canvas 文字采样点 / 斐波那契球面 / 圆环扭结。
 * - 顶点着色器按 uPhase（0→3 循环）在相邻两组之间做三段插值，插值路径上加
 *   「飞行弧」与逐粒子相位差，粒子云不是直线飞而是炸开再聚拢。
 * - CPU 每帧只更新一个 uniform，两万个粒子的轨迹全在 GPU 上。
 */

const N = 20000

/** canvas 画字并采样出粒子目标点 */
function sampleText(text: string, count: number): Float32Array {
  const cw = 640
  const ch = 260
  const cv = document.createElement('canvas')
  cv.width = cw
  cv.height = ch
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.font = '900 190px Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cw / 2, ch / 2 + 8)

  const img = ctx.getImageData(0, 0, cw, ch).data
  const pts: number[] = []
  const step = 3
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      if (img[(y * cw + x) * 4 + 3] > 128) {
        pts.push(
          (x / cw - 0.5) * 30,
          -(y / ch - 0.5) * 12.5,
          (Math.random() - 0.5) * 1.6,
        )
      }
    }
  }
  // 点数对齐：多退少补（重复随机抽样）
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const j = Math.floor((i / count) * pts.length / 3) * 3
    // 加一点抖动让文字有颗粒感
    out[i * 3] = pts[j] + (Math.random() - 0.5) * 0.35
    out[i * 3 + 1] = pts[j + 1] + (Math.random() - 0.5) * 0.35
    out[i * 3 + 2] = pts[j + 2]
  }
  return out
}

/** 斐波那契球面均匀分布 */
function fibonacciSphere(count: number, r: number): Float32Array {
  const out = new Float32Array(count * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const rad = Math.sqrt(1 - y * y)
    const th = golden * i
    out[i * 3] = Math.cos(th) * rad * r
    out[i * 3 + 1] = y * r
    out[i * 3 + 2] = Math.sin(th) * rad * r
  }
  return out
}

/** (3,4) 环面扭结曲线：粒子沿曲线撒成光带 */
function torusKnotCurve(count: number, r: number): Float32Array {
  const out = new Float32Array(count * 3)
  const p = 3
  const q = 4
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2 * q + Math.random() * 0.02
    const rk = r * (2 + Math.cos((q * t) / p))
    // 沿曲线的随机截面半径，形成有粗细的光带
    const a = Math.random() * Math.PI * 2
    const rr = Math.pow(Math.random(), 2) * 1.1
    out[i * 3] = rk * Math.cos(t) + Math.cos(a) * rr
    out[i * 3 + 1] = r * Math.sin((q * t) / p) + Math.sin(a) * rr
    out[i * 3 + 2] = rk * Math.sin(t) + Math.cos(a) * rr
  }
  return out
}

const vertexShader = /* glsl */ `
attribute vec3 aPos0; // 文字
attribute vec3 aPos1; // 球面
attribute vec3 aPos2; // 扭结光带
attribute float aRand;

uniform float uPhase; // 0→3 循环推进
uniform vec3 uMouse;  // 世界坐标斥力点
uniform float uTime;

varying float vMix;
varying float vRand;

float ease(float t) {
  return t * t * (3.0 - 2.0 * t); // smoothstep 缓动
}

void main() {
  vRand = aRand;
  float ph = mod(uPhase, 3.0);

  // 逐粒子相位差：aRand 越大出发越晚，云团有「先后感」
  float lag = clamp((ph - aRand * 0.35) / 0.65, 0.0, 1.0);

  vec3 a = aPos0;
  vec3 b = aPos1;
  float t = ease(lag);
  if (ph >= 1.0 && ph < 2.0) { a = aPos1; b = aPos2; }
  else if (ph >= 2.0)        { a = aPos2; b = aPos0; }
  vMix = t;

  vec3 pos = mix(a, b, t);

  // 飞行弧：过渡中段把粒子沿「a 与 b 的垂线方向」顶出去，炸开再聚拢
  float arc = sin(t * 3.14159);
  vec3 dirAB = normalize(b - a + vec3(0.0001));
  vec3 side = normalize(cross(dirAB, vec3(0.0, 1.0, 0.0)) + vec3(0.001));
  pos += side * arc * (1.5 + aRand * 3.0);

  // 待机呼吸：轻微噪声漂移
  pos.x += sin(uTime * 0.8 + aRand * 40.0) * 0.12;
  pos.y += cos(uTime * 0.7 + aRand * 35.0) * 0.12;

  // 鼠标斥力
  vec3 toM = pos - uMouse;
  float md = length(toM);
  if (md < 4.5) {
    pos += normalize(toM) * (4.5 - md) * 0.8;
  }

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = (2.2 + aRand * 2.2) * (24.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`

const fragmentShader = /* glsl */ `
uniform float uTime;
varying float vMix;
varying float vRand;

void main() {
  // 圆形软点精灵
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float alpha = smoothstep(0.5, 0.12, d);

  // 颜色随过渡进度流动：青 → 品红 → 金
  vec3 cA = vec3(0.20, 0.75, 1.00);
  vec3 cB = vec3(1.00, 0.35, 0.85);
  vec3 cC = vec3(1.00, 0.80, 0.30);
  vec3 col = mix(cA, cB, vMix);
  col = mix(col, cC, 0.5 + 0.5 * sin(uTime * 0.5 + vRand * 6.28));

  gl_FragColor = vec4(col, alpha * (0.75 + 0.25 * sin(vRand * 30.0 + uTime)));
}
`

let phase = 0
let targetPhase = 0
const mouseWorld = new THREE.Vector3(999, 999, 999)

useThree(
  container,
  {
    background: 0x05070e,
    cameraPos: [0, 0, 34],
    lookAt: [0, 0, 0],
    controls: true,
    far: 300,
  },
  ({ scene, renderer, camera }) => {
    const pos0 = sampleText('VIZFORGE', N)
    const pos1 = fibonacciSphere(N, 9)
    const pos2 = torusKnotCurve(N, 5.2)

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos0.slice(), 3)) // 供 raycast/包围球
    geometry.setAttribute('aPos0', new THREE.BufferAttribute(pos0, 3))
    geometry.setAttribute('aPos1', new THREE.BufferAttribute(pos1, 3))
    geometry.setAttribute('aPos2', new THREE.BufferAttribute(pos2, 3))
    const rnd = new Float32Array(N)
    for (let i = 0; i < N; i++) rnd[i] = Math.random()
    geometry.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1))

    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uPhase: { value: 0 },
        uTime: { value: 0 },
        uMouse: { value: mouseWorld },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    materialRef.value = mat
    scene.add(new THREE.Points(geometry, mat))

    // 鼠标斥力：把指针投影到 z=0 平面
    const ndc = new THREE.Vector2()
    const ray = new THREE.Raycaster()
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const onMove = (e: PointerEvent) => {
      const el = renderer.domElement
      const rect = el.getBoundingClientRect()
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      ray.setFromCamera(ndc, camera)
      ray.ray.intersectPlane(plane, mouseWorld)
    }
    const onLeave = () => mouseWorld.set(999, 999, 999)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)

    let autoClock = 0
    return (dt) => {
      // 相位向目标平滑推进（一段 1.2s 左右）
      phase += (targetPhase - phase) * Math.min(1, dt * 2.2)
      if (Math.abs(targetPhase - phase) < 0.002) phase = targetPhase

      if (autoPlay.value) {
        autoClock += dt
        if (autoClock > 4.2) {
          autoClock = 0
          nextShape()
        }
      }

      mat.uniforms.uPhase.value = phase
      mat.uniforms.uTime.value += dt

      // 整体缓慢自转
      scene.rotation.y += dt * 0.12
    }
  },
)

function nextShape() {
  targetPhase += 1
  const shapes = ['文字', '球面', '光环']
  phaseLabel.value = shapes[Math.round(targetPhase) % 3]
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">当前形态</span>
        <span class="val2">{{ phaseLabel }}</span>
        <button class="btn" @click="nextShape">下一个</button>
        <button class="btn" :class="{ active: autoPlay }" @click="autoPlay = !autoPlay">
          {{ autoPlay ? '自动轮播中' : '自动轮播' }}
        </button>
      </div>
      <div class="tip">
        2 万粒子在 GPU 上于「canvas 文字 / 斐波那契球面 / 环面扭结光带」三形态间插值，
        过渡带飞行弧与逐粒子相位差；移动鼠标可推开粒子云。
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
.three-container {
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
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
}
.val2 {
  font-size: 13px;
  color: #7ee787;
  min-width: 34px;
}
.btn {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #9fb0c2;
  cursor: pointer;
}
.btn.active {
  background: #1f5c9e;
  color: #fff;
  border-color: #4f9dff;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
