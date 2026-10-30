<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'

const container = ref<HTMLDivElement>()
const info = ref('点击任意彩色几何体，试试射线拾取')
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let group: THREE.Group
let raf = 0
let selected: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

function resize() {
  if (!container.value) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function onPointerDown(event: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)

  const hits = raycaster.intersectObjects(group.children, false)
  if (selected) selected.material.emissive.setHex(0x000000)

  if (hits.length > 0) {
    const obj = hits[0].object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
    selected = obj
    obj.material.emissive.setHex(0x666666)
    info.value = `命中：${obj.userData.name as string}`
  } else {
    selected = null
    info.value = '未命中，点击彩色几何体试试'
  }
}

onMounted(() => {
  const el = container.value!
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a0e16)

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 100)
  camera.position.set(0, 2.2, 7)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'

  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const key = new THREE.DirectionalLight(0xffffff, 2)
  key.position.set(4, 6, 5)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x4f9dff, 1)
  fill.position.set(-5, 2, -4)
  scene.add(fill)

  group = new THREE.Group()
  const geos: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.SphereGeometry(0.62, 32, 24),
    new THREE.IcosahedronGeometry(0.72, 0),
    new THREE.TorusGeometry(0.56, 0.2, 16, 48),
    new THREE.ConeGeometry(0.58, 1, 24),
    new THREE.CylinderGeometry(0.48, 0.48, 1, 24),
  ]
  const colors = [0x4f9dff, 0xff5e62, 0x7ee787, 0xffa657, 0xd2a8ff, 0x79c0ff]
  const names = ['立方体', '球体', '二十面体', '圆环', '圆锥', '圆柱']

  for (let i = 0; i < geos.length; i++) {
    const angle = (i / geos.length) * Math.PI * 2
    const mesh = new THREE.Mesh(
      geos[i],
      new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.35, metalness: 0.25 }),
    )
    mesh.position.set(Math.cos(angle) * 2.5, i % 2 === 0 ? 0.6 : -0.5, Math.sin(angle) * 2.5)
    mesh.userData.name = names[i]
    group.add(mesh)
  }
  scene.add(group)

  resize()
  window.addEventListener('resize', resize)
  renderer.domElement.addEventListener('pointerdown', onPointerDown)

  const animate = () => {
    raf = requestAnimationFrame(animate)
    group.rotation.y += 0.004
    renderer.render(scene, camera)
  }
  animate()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  renderer?.domElement.removeEventListener('pointerdown', onPointerDown)
  renderer?.dispose()
})
</script>

<template>
  <div ref="container" class="three-container">
    <div class="hint">{{ info }}</div>
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
