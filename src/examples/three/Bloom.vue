<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const strength = ref(0.6)
let bloomPass: UnrealBloomPass | null = null

useThree(
  container,
  {
    background: 0x04060b,
    cameraPos: [0, 1.5, 9],
    lookAt: [0, 0, 0],
    controls: true,
    // 交给 EffectComposer 自行渲染
    autoLoop: false,
  },
  ({ scene, camera, renderer }) => {
    scene.fog = new THREE.FogExp2(0x04060b, 0.035)

    // 发光小球阵列
    const group = new THREE.Group()
    const colors = [0x4f9dff, 0x7ee787, 0xff7b72, 0xffa657, 0xb392f0, 0x22d3ee]
    for (let i = 0; i < 6; i++) {
      const material = new THREE.MeshStandardMaterial({
        color: colors[i],
        emissive: new THREE.Color(colors[i]),
        emissiveIntensity: 1.05,
        roughness: 0.25,
        metalness: 0.3,
      })
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.55, 48, 32), material)
      const a = (i / 6) * Math.PI * 2
      sphere.position.set(Math.cos(a) * 2.6, Math.sin(a * 2) * 0.8, Math.sin(a) * 2.6)
      group.add(sphere)
    }
    scene.add(group)
    scene.add(new THREE.AmbientLight(0xffffff, 0.25))
    const dir = new THREE.DirectionalLight(0xffffff, 1.1)
    dir.position.set(4, 6, 5)
    scene.add(dir)

    // 后期处理：渲染 → 泛光
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(container.value?.clientWidth ?? 1, container.value?.clientHeight ?? 1),
      strength.value,
      0.55,
      0.32,
    )
    composer.addPass(bloom)
    bloomPass = bloom

    const clock = new THREE.Clock()
    let raf = 0
    let disposed = false

    const loop = () => {
      if (disposed) return
      raf = requestAnimationFrame(loop)
      const dt = clock.getDelta()
      group.rotation.y += dt * 0.35
      group.children.forEach((c, i) => {
        c.position.y = Math.sin(performance.now() / 700 + i) * 0.9
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
    onResize()

    onBeforeUnmount(() => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      composer.dispose()
    })
  },
)

function onStrengthInput(v: number) {
  strength.value = v
  if (bloomPass) bloomPass.strength = v
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">泛光强度</span>
        <input
          class="range"
          type="range"
          min="0"
          max="2"
          step="0.05"
          :value="strength"
          @input="onStrengthInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ strength.toFixed(2) }}</span>
      </div>
      <div class="tip">EffectComposer + RenderPass + UnrealBloomPass 组成的后期处理链。</div>
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
  width: 300px;
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
  white-space: nowrap;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 36px;
  text-align: right;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
