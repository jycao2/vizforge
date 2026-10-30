<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const COUNT = 6000

useThree(
  container,
  {
    background: 0x080c14,
    cameraPos: [0, 6, 14],
    lookAt: [0, 0, 0],
    controls: true,
  },
  ({ scene }) => {
    const geometry = new THREE.BoxGeometry(0.16, 0.16, 0.16)
    const material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 })
    const mesh = new THREE.InstancedMesh(geometry, material, COUNT)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()

    for (let i = 0; i < COUNT; i++) {
      // 立方体堆成一个球壳，视觉更集中
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 4.2 + (Math.random() - 0.5) * 0.6
      dummy.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      )
      dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0)
      dummy.scale.setScalar(0.6 + Math.random() * 1.4)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)

      color.setHSL(0.55 + (dummy.position.y / 9) * 0.35, 0.75, 0.55)
      mesh.setColorAt(i, color)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

    scene.add(mesh)
    scene.add(new THREE.HemisphereLight(0x9fd0ff, 0x101820, 1.1))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(6, 8, 6)
    scene.add(key)

    return (dt) => {
      mesh.rotation.y += dt * 0.16
      mesh.rotation.x = Math.sin(performance.now() / 4000) * 0.2
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="tip">InstancedMesh 单次 draw call 渲染 {{ COUNT }} 个立方体，逐实例设置矩阵与颜色。</div>
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
.tip {
  position: absolute;
  left: 14px;
  bottom: 14px;
  padding: 7px 12px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.85);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #c6d3e1;
  font-size: 12px;
  pointer-events: none;
}
</style>
