<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'

const container = ref<HTMLDivElement>()
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let mesh: THREE.Mesh
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
  scene.background = new THREE.Color(0x0b0f1a)

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 100)
  camera.position.z = 3

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'

  const geometry = new THREE.BoxGeometry(1.3, 1.3, 1.3)
  const material = new THREE.MeshNormalMaterial()
  mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)

  resize()
  window.addEventListener('resize', resize)

  const animate = () => {
    raf = requestAnimationFrame(animate)
    mesh.rotation.x += 0.01
    mesh.rotation.y += 0.013
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
