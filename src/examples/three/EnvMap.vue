<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()

useThree(
  container,
  {
    background: 0x090d14,
    cameraPos: [0, 1.4, 9],
    lookAt: [0, 0, 0],
    controls: true,
  },
  ({ scene, renderer }) => {
    // 用程序化的房间环境生成 IBL 反射贴图，无需外部 HDR 资源
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envTexture = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture
    scene.environment = envTexture

    const group = new THREE.Group()
    scene.add(group)

    // 一排金属球：粗糙度从 0 → 1
    for (let i = 0; i < 6; i++) {
      const roughness = i / 5
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 64, 48),
        new THREE.MeshStandardMaterial({
          color: 0xc8d3e2,
          metalness: 1,
          roughness,
          envMapIntensity: 1.1,
        }),
      )
      sphere.position.set(-3.1 + i * 1.24, 0.5, 0)
      group.add(sphere)
    }

    // 中间一个彩色高反射体
    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.85, 0.28, 220, 32, 2, 3),
      new THREE.MeshStandardMaterial({
        color: 0x4f9dff,
        metalness: 1,
        roughness: 0.12,
        envMapIntensity: 1.4,
      }),
    )
    knot.position.set(0, 0.5, -3.1)
    group.add(knot)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: 0x0f151d, roughness: 0.9, metalness: 0 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -1.9
    scene.add(ground)

    return (dt) => {
      group.rotation.y += dt * 0.25
      knot.rotation.x += dt * 0.4
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="tip">PMREMGenerator + RoomEnvironment 生成环境贴图，金属材质按粗糙度呈现不同反射。</div>
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
