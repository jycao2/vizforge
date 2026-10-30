<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const container = ref<HTMLDivElement>()
const loading = ref(true)
const error = ref('')
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let raf = 0

const DUCK_URL =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Duck/glTF-Binary/Duck.glb'

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

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 200)
  camera.position.set(0, 1.6, 4.2)

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
  controls.autoRotateSpeed = 1.2
  controls.target.set(0, 0, 0)

  scene.add(new THREE.AmbientLight(0xffffff, 0.7))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(4, 6, 5)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x4f9dff, 1.2)
  rim.position.set(-5, 2, -4)
  scene.add(rim)

  const grid = new THREE.GridHelper(8, 16, 0x243244, 0x1a2330)
  grid.position.y = -1
  scene.add(grid)

  resize()
  window.addEventListener('resize', resize)

  const loader = new GLTFLoader()
  loader.load(
    DUCK_URL,
    (gltf) => {
      const model = gltf.scene
      model.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z) || 1
      const s = 2 / maxDim
      model.scale.setScalar(s)
      model.position.copy(center).multiplyScalar(-s)
      scene.add(model)
      loading.value = false
    },
    undefined,
    (err) => {
      error.value = '模型加载失败：' + String(err)
      loading.value = false
    },
  )

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
    <div v-if="loading" class="hint">模型加载中…</div>
    <div v-else-if="error" class="hint error">{{ error }}</div>
    <div v-else class="hint">Duck.glb · 拖拽旋转 · 滚轮缩放</div>
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
.hint.error {
  color: #ff7b72;
}
</style>
