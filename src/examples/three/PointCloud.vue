<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const pointSize = ref(0.012)
const COUNT = 140000

let points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null

/**
 * 斐波那契球面采样：用黄金角步进保证点在球面上近似均匀，
 * 再叠加一层径向起伏，模拟激光扫描得到的一层「点云球壳」。
 */
function buildPointCloud() {
  const positions = new Float32Array(COUNT * 3)
  const colors = new Float32Array(COUNT * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))

  const cLow = new THREE.Color('#123c6b')
  const cMid = new THREE.Color('#4f9dff')
  const cHigh = new THREE.Color('#8ef0d4')
  const cTop = new THREE.Color('#ffffff')
  const tmp = new THREE.Color()

  for (let i = 0; i < COUNT; i++) {
    const y = 1 - (i / (COUNT - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i

    // 径向起伏：两个不同频率的正弦叠加，形成起伏的「地形感」
    const bump =
      1 + 0.075 * Math.sin(theta * 5.0) * Math.cos(y * 7.5) + 0.035 * Math.sin(theta * 13.0 + y * 3)

    positions[i * 3] = Math.cos(theta) * r * bump
    positions[i * 3 + 1] = y * bump
    positions[i * 3 + 2] = Math.sin(theta) * r * bump

    // 按纬度 + 起伏高度上色
    const t = THREE.MathUtils.clamp((y + bump - 1) * 0.62 + 0.5, 0, 1)
    if (t < 0.45) tmp.copy(cLow).lerp(cMid, t / 0.45)
    else if (t < 0.78) tmp.copy(cMid).lerp(cHigh, (t - 0.45) / 0.33)
    else tmp.copy(cHigh).lerp(cTop, (t - 0.78) / 0.22)

    colors[i * 3] = tmp.r
    colors[i * 3 + 1] = tmp.g
    colors[i * 3 + 2] = tmp.b
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const material = new THREE.PointsMaterial({
    size: pointSize.value,
    vertexColors: true,
    sizeAttenuation: true,
  })

  return new THREE.Points(geometry, material)
}

useThree(
  container,
  {
    background: 0x03060c,
    cameraPos: [0, 0.9, 4.6],
    lookAt: [0, 0, 0],
    controls: true,
  },
  ({ scene }) => {
    points = buildPointCloud()
    scene.add(points)

    // 一层极淡的星点背景，避免纯黑
    const bg = new THREE.BufferGeometry()
    const bgPos = new Float32Array(1200 * 3)
    for (let i = 0; i < 1200; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(28 + Math.random() * 18)
      bgPos.set([v.x, v.y, v.z], i * 3)
    }
    bg.setAttribute('position', new THREE.BufferAttribute(bgPos, 3))
    scene.add(
      new THREE.Points(
        bg,
        new THREE.PointsMaterial({ size: 0.06, color: 0x4a5d78, sizeAttenuation: true }),
      ),
    )

    return (dt) => {
      if (!points) return
      points.rotation.y += dt * 0.18
      points.rotation.x = Math.sin(performance.now() / 9000) * 0.12
    }
  },
)

function onSizeInput(v: number) {
  pointSize.value = v
  if (points) points.material.size = v
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">点大小</span>
        <input
          class="range"
          type="range"
          min="0.004"
          max="0.03"
          step="0.001"
          :value="pointSize"
          @input="onSizeInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ pointSize.toFixed(3) }}</span>
      </div>
      <div class="tip">
        {{ COUNT.toLocaleString() }} 个顶点一次性塞进 BufferGeometry，Points + vertexColors 单次
        draw call 完成渲染，这是点云/激光雷达数据最常用的画法。
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
  width: 320px;
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
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  width: 40px;
  text-align: right;
  font-size: 12px;
  color: #7ee787;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
