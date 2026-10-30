<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const container = ref<HTMLDivElement>()
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
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

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 100)
  camera.position.set(3, 2, 4)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.autoRotate = true
  controls.autoRotateSpeed = 1.6
  controls.target.set(0, 0, 0)

  const geometry = new THREE.TorusKnotGeometry(1, 0.34, 160, 28)
  const material = new THREE.MeshStandardMaterial({
    color: 0x4f9dff,
    roughness: 0.28,
    metalness: 0.65,
  })
  scene.add(new THREE.Mesh(geometry, material))

  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(4, 5, 4)
  scene.add(key)
  scene.add(new THREE.AmbientLight(0x6688ff, 0.5))

  resize()
  window.addEventListener('resize', resize)

  const animate = () => {
    raf = requestAnimationFrame(animate)
    controls.update()
    renderer.render(scene, camera)
  }
  animate()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  controls?.dispose()
  renderer?.dispose()
})
</script>

<template>
  <div ref="container" class="three-container">
    <div class="hint">拖拽旋转 · 滚轮缩放 · 右键平移</div>
  </div>
</template>

<style scoped>
.three-container {
  position: relative;
  width: 100%;
  height: 100%;
}
.hint {
  position: absolute;
  left: 14px;
  bottom: 14px;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.85);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 12px;
  pointer-events: none;
}
</style>
