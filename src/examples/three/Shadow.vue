<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const meshes: THREE.Mesh[] = []

useThree(
  container,
  {
    background: 0x0d1420,
    cameraPos: [7, 6, 9],
    lookAt: [0, 0.8, 0],
    controls: true,
    shadows: true,
  },
  ({ scene }) => {
    // 地面
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.95, metalness: 0.05 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    // 平行光 + 阴影相机
    const light = new THREE.DirectionalLight(0xffffff, 2.4)
    light.position.set(6, 10, 5)
    light.castShadow = true
    light.shadow.mapSize.set(1024, 1024)
    const d = 11
    light.shadow.camera.left = -d
    light.shadow.camera.right = d
    light.shadow.camera.top = d
    light.shadow.camera.bottom = -d
    light.shadow.camera.near = 1
    light.shadow.camera.far = 32
    light.shadow.bias = -0.0005
    scene.add(light)
    scene.add(new THREE.AmbientLight(0xffffff, 0.42))

    // 几个会投影的物体
    const geoms = [
      new THREE.BoxGeometry(1.4, 1.4, 1.4),
      new THREE.SphereGeometry(0.9, 48, 32),
      new THREE.TorusKnotGeometry(0.65, 0.24, 128, 24),
      new THREE.ConeGeometry(0.9, 1.8, 48),
      new THREE.CylinderGeometry(0.7, 0.7, 1.4, 48),
    ]
    const colors = [0x4f9dff, 0x7ee787, 0xffa657, 0xff7b72, 0xb392f0]
    geoms.forEach((g, i) => {
      const m = new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.35, metalness: 0.25 }),
      )
      const angle = (i / geoms.length) * Math.PI * 2
      m.position.set(Math.cos(angle) * 2.6, 0.9, Math.sin(angle) * 2.6)
      m.castShadow = true
      m.receiveShadow = true
      scene.add(m)
      meshes.push(m)
    })

    return (dt) => {
      meshes.forEach((m, i) => {
        m.rotation.y += dt * (0.35 + i * 0.08)
        m.position.y = 0.9 + Math.abs(Math.sin(performance.now() / 900 + i)) * 0.5
      })
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="tip">DirectionalLight + castShadow / receiveShadow，开启 PCF 软阴影。</div>
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
