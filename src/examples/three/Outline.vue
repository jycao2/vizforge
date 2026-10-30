<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const selectedName = ref('点击任意物体选中')

let outlinePass: OutlinePass | null = null
const pickables: THREE.Mesh[] = []

useThree(
  container,
  {
    background: 0x080b12,
    cameraPos: [0, 4.2, 14.5],
    lookAt: [0, 1.5, 0],
    controls: true,
    shadows: true,
    // 交给 EffectComposer 渲染
    autoLoop: false,
  },
  ({ scene, camera, renderer }) => {
    scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a1f28, 0.85))
    const dir = new THREE.DirectionalLight(0xffffff, 2.2)
    dir.position.set(5, 9, 6)
    dir.castShadow = true
    scene.add(dir)

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(16, 64),
      new THREE.MeshStandardMaterial({ color: 0x141b26, roughness: 0.95 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    const defs: { name: string; geo: THREE.BufferGeometry; color: number; y: number }[] = [
      { name: '立方体', geo: new THREE.BoxGeometry(1.6, 1.6, 1.6), color: 0x4f9dff, y: 1.5 },
      { name: '二十面体', geo: new THREE.IcosahedronGeometry(1.05, 0), color: 0x7ee787, y: 1.6 },
      { name: '环面结', geo: new THREE.TorusKnotGeometry(0.78, 0.26, 160, 24), color: 0xffc46b, y: 1.7 },
      { name: '球体', geo: new THREE.SphereGeometry(1.05, 40, 28), color: 0xb392f0, y: 1.6 },
      { name: '圆锥', geo: new THREE.ConeGeometry(1.1, 2.2, 40), color: 0xff7b72, y: 1.6 },
      { name: '圆环', geo: new THREE.TorusGeometry(0.9, 0.3, 24, 64), color: 0x22d3ee, y: 1.8 },
    ]

    defs.forEach((d, i) => {
      const mesh = new THREE.Mesh(
        d.geo,
        new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.38, metalness: 0.35 }),
      )
      mesh.position.set(-5.2 + i * 2.1, d.y, 0)
      mesh.castShadow = true
      mesh.userData.name = d.name
      scene.add(mesh)
      pickables.push(mesh)
    })

    // 后期处理：主渲染 → 描边高亮
    const w = container.value?.clientWidth || 1
    const h = container.value?.clientHeight || 1
    const composer = new EffectComposer(renderer)
    // EffectComposer 以构造时的渲染器尺寸为准，这里先按容器实际尺寸初始化，
    // 否则渲染目标会是 300×150 的默认值
    composer.setSize(w, h)
    composer.addPass(new RenderPass(scene, camera))

    const outline = new OutlinePass(new THREE.Vector2(w, h), scene, camera)
    outline.edgeStrength = 4.5
    outline.edgeGlow = 0.7
    outline.edgeThickness = 2.2
    outline.pulsePeriod = 0
    outline.visibleEdgeColor.set('#4f9dff')
    outline.hiddenEdgeColor.set('#1c4a7d')
    composer.addPass(outline)
    outlinePass = outline

    // 默认选中第一个
    outline.selectedObjects = [pickables[0]]
    selectedName.value = pickables[0].userData.name as string

    const ray = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    const onPointerDown = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      ray.setFromCamera(pointer, camera)
      const hit = ray.intersectObjects(pickables, false)[0]
      if (hit) {
        outline.selectedObjects = [hit.object]
        selectedName.value = hit.object.userData.name as string
      } else {
        outline.selectedObjects = []
        selectedName.value = '未选中'
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)

    const clock = new THREE.Clock()
    let raf = 0
    let disposed = false
    const loop = () => {
      if (disposed) return
      raf = requestAnimationFrame(loop)
      const dt = clock.getDelta()
      pickables.forEach((m, i) => {
        m.rotation.y += dt * (0.25 + i * 0.05)
        m.rotation.x += dt * 0.08
        m.position.y += Math.sin(performance.now() / 800 + i) * dt * 0.15
      })
      composer.render()
    }
    loop()

    const onResize = () => {
      const el = container.value
      if (!el) return
      composer.setSize(el.clientWidth || 1, el.clientHeight || 1)
    }
    window.addEventListener('resize', onResize)

    onBeforeUnmount(() => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      composer.dispose()
    })
  },
)

function clearSelection() {
  if (!outlinePass) return
  outlinePass.selectedObjects = []
  selectedName.value = '未选中'
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">当前选中</span>
        <span class="name">{{ selectedName }}</span>
        <button class="btn" @click="clearSelection">清除</button>
      </div>
      <div class="tip">
        OutlinePass 会先把选中物体渲染到一张遮罩纹理，再做边缘检测叠加发光描边，是模型点选高亮的
        标准做法。
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
}
.name {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: #4f9dff;
}
.btn {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: rgba(255, 255, 255, 0.05);
  color: #c6d3e1;
  font-size: 11.5px;
  cursor: pointer;
}
.btn:hover {
  background: rgba(79, 157, 255, 0.18);
  border-color: rgba(79, 157, 255, 0.6);
  color: #fff;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
