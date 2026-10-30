<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'

const container = ref<HTMLDivElement>()
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let points: THREE.Points
let raf = 0

function resize() {
  if (!container.value) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

onMounted(() => {
  const el = container.value!
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x05070d)

  camera = new THREE.PerspectiveCamera(60, el.clientWidth / el.clientHeight, 0.1, 100)
  camera.position.z = 6

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'

  const count = 1800
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 12
    positions[i * 3 + 1] = (Math.random() - 0.5) * 12
    positions[i * 3 + 2] = (Math.random() - 0.5) * 12
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const material = new THREE.PointsMaterial({
    color: 0x88ccff,
    size: 0.06,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
  })
  points = new THREE.Points(geometry, material)
  scene.add(points)

  resize()
  window.addEventListener('resize', resize)

  const animate = () => {
    raf = requestAnimationFrame(animate)
    points.rotation.y += 0.0025
    points.rotation.x += 0.001
    renderer.render(scene, camera)
  }
  animate()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  renderer?.dispose()
})
</script>

<template>
  <div ref="container" class="three-container"></div>
</template>

<style scoped>
.three-container {
  width: 100%;
  height: 100%;
}
</style>
