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
  scene.background = new THREE.Color(0x0a0e16)

  camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 100)
  camera.position.set(0, 0, 3.2)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'

  const geometry = new THREE.SphereGeometry(1, 64, 48)
  const material = new THREE.MeshStandardMaterial({
    color: 0x4f9dff,
    roughness: 0.35,
    metalness: 0.25,
  })
  mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)

  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(3, 3, 3)
  scene.add(key)
  scene.add(new THREE.AmbientLight(0x6688ff, 0.55))

  resize()
  window.addEventListener('resize', resize)

  const animate = () => {
    raf = requestAnimationFrame(animate)
    mesh.rotation.y += 0.006
    mesh.rotation.x += 0.002
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
