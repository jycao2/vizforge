<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

const container = ref<HTMLDivElement>()
const bloomStrength = ref(1.2)
const motionBlur = ref(0.82)
const aberration = ref(1.0)
const grain = ref(0.5)
const vignette = ref(0.7)

/**
 * 后处理链（参考 Crystal-Bird 的管线：Bloom → Motion Blur → 色差 → 胶片颗粒）：
 *   RenderPass → UnrealBloomPass → AfterimagePass → 自定义电影感 ShaderPass
 * - UnrealBloom：亮部提取 + 多级模糊 + 叠回，霓虹质感的来源。
 * - Afterimage：上一帧按系数混合进当前帧，运动物体拖出光尾（廉价运动模糊）。
 * - 最后一个 pass 一次搞定色差（RGB 通道径向错位）/ 颗粒 / 暗角 / 轻微调色，
 *   一次全屏绘制，不额外增加多少开销。
 */

// —— 自定义「电影感」合成 pass ——
const CinemaShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAberration: { value: 1.0 },
    uGrain: { value: 0.5 },
    uVignette: { value: 0.7 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uTime;
    varying vec2 vUv;

    // 伪随机
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);

      // 色差：RGB 沿径向错开（离中心越远错得越多）
      vec2 off = c * uAberration * 0.006 * r;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      // 轻微调色：阴影偏青、高光偏暖（好莱坞橙青调）
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col * vec3(0.92, 1.0, 1.08), col * vec3(1.06, 1.0, 0.94), smoothstep(0.35, 0.65, lum));

      // 胶片颗粒：随时间闪烁的噪声，暗部更明显
      float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 7.13) - 0.5;
      col += g * uGrain * 0.09 * (1.2 - lum);

      // 暗角：径向衰减
      col *= 1.0 - smoothstep(0.45, 1.05, r) * uVignette * 0.85;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

useThree(
  container,
  {
    background: 0x04050a,
    cameraPos: [0, 0, 16],
    lookAt: [0, 0, 0],
    controls: true,
    autoLoop: false, // 用 EffectComposer 接管渲染循环
    far: 300,
  },
  ({ scene, camera, renderer }) => {
    // —— 场景：霓虹时光隧道 ——
    const rings: THREE.Mesh[] = []
    for (let i = 0; i < 28; i++) {
      const hue = (i / 28) * 0.85
      const col = new THREE.Color().setHSL(hue, 0.9, 0.55)
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.1, 0.055, 12, 96),
        new THREE.MeshBasicMaterial({ color: col }),
      )
      ring.position.z = -i * 2.6
      ring.rotation.z = i * 0.22
      rings.push(ring)
      scene.add(ring)

      // 每个环挂一颗发光珠，旋转时 Bloom 拖出弧形光尾
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 12, 10),
        new THREE.MeshBasicMaterial({ color: col.clone().offsetHSL(0, 0, 0.25) }),
      )
      ring.add(orb)
      orb.position.set(3.1, 0, 0)
    }
    // 星尘
    const starGeo = new THREE.BufferGeometry()
    const N = 1200
    const arr = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 44
      arr[i * 3 + 1] = (Math.random() - 0.5) * 30
      arr[i * 3 + 2] = -Math.random() * 80
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    scene.add(
      new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({ color: 0x9fd0ff, size: 0.07, transparent: true, opacity: 0.8 }),
      ),
    )

    // —— 后处理链 ——
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(container.value?.clientWidth || 1, container.value?.clientHeight || 1),
      1.2,
      0.55,
      0.12,
    )
    composer.addPass(bloom)

    const afterimage = new AfterimagePass(0.82)
    composer.addPass(afterimage)

    const cinema = new ShaderPass(CinemaShader)
    composer.addPass(cinema)

    // 尺寸自适应：composer 跟着 canvas 走
    function resize() {
      const el = container.value
      if (!el) return
      const w = el.clientWidth || 1
      const h = el.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      composer.setSize(w, h)
    }
    window.addEventListener('resize', resize)
    resize()

    let raf = 0
    const clock = new THREE.Clock()
    let t = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(clock.getDelta(), 0.05)
      t += dt

      // 隧道动效：环呼吸 + 整体旋转 + 波浪扭动
      rings.forEach((r, i) => {
        r.rotation.z += dt * (0.12 + i * 0.004)
        r.scale.setScalar(1 + Math.sin(t * 1.4 + i * 0.45) * 0.07)
        r.position.x = Math.sin(t * 0.7 + i * 0.32) * 1.1
        r.position.y = Math.cos(t * 0.55 + i * 0.27) * 0.8
      })

      // 参数同步
      bloom.strength = bloomStrength.value
      afterimage.uniforms['damp'].value = motionBlur.value
      cinema.uniforms.uAberration.value = aberration.value
      cinema.uniforms.uGrain.value = grain.value
      cinema.uniforms.uVignette.value = vignette.value
      cinema.uniforms.uTime.value = t

      composer.render()
    }
    loop()

    onBeforeUnmount(() => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      composer.dispose()
    })
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">Bloom</span>
        <input
          class="range"
          type="range"
          min="0"
          max="2.5"
          step="0.05"
          :value="bloomStrength"
          @input="bloomStrength = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ bloomStrength.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">运动模糊</span>
        <input
          class="range"
          type="range"
          min="0"
          max="0.96"
          step="0.02"
          :value="motionBlur"
          @input="motionBlur = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ motionBlur.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">色差</span>
        <input
          class="range"
          type="range"
          min="0"
          max="3"
          step="0.1"
          :value="aberration"
          @input="aberration = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ aberration.toFixed(1) }}</span>
      </div>
      <div class="row">
        <span class="label">颗粒</span>
        <input
          class="range"
          type="range"
          min="0"
          max="2"
          step="0.05"
          :value="grain"
          @input="grain = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ grain.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">暗角</span>
        <input
          class="range"
          type="range"
          min="0"
          max="1.5"
          step="0.05"
          :value="vignette"
          @input="vignette = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ vignette.toFixed(2) }}</span>
      </div>
      <div class="tip">
        管线：RenderPass → UnrealBloom（辉光）→ Afterimage（帧回显拖影）→
        自定义 pass 一次完成色差 / 橙青调色 / 胶片颗粒 / 暗角。拖动滑杆逐层观察每个环节的贡献。
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
  margin-bottom: 6px;
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
