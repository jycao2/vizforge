import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export interface ThreeCtx {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  controls?: OrbitControls
}

export interface ThreeOptions {
  fov?: number
  near?: number
  far?: number
  background?: number | string
  cameraPos?: [number, number, number]
  lookAt?: [number, number, number]
  controls?: boolean
  /** 开启阴影贴图 */
  shadows?: boolean
  /** 关闭自动循环（如需手动 render） */
  autoLoop?: boolean
}

/**
 * Three.js 场景样板：渲染器 / 相机 / 尺寸自适应 / RAF 循环 / 销毁。
 * 示例组件只需在 setup 回调里搭建场景，并返回每帧更新函数。
 */
export function useThree(
  container: Ref<HTMLDivElement | undefined>,
  options: ThreeOptions,
  setup: (ctx: ThreeCtx) => ((dt: number) => void) | void,
): ThreeCtx {
  const ctx = {} as ThreeCtx
  let raf = 0
  let update: ((dt: number) => void) | undefined
  const clock = new THREE.Clock()

  function resize() {
    const el = container.value
    if (!el || !ctx.renderer) return
    const w = el.clientWidth || 1
    const h = el.clientHeight || 1
    ctx.renderer.setSize(w, h, false)
    ctx.camera.aspect = w / h
    ctx.camera.updateProjectionMatrix()
  }

  onMounted(() => {
    const el = container.value
    if (!el) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(options.background ?? 0x0b0f1a)

    const camera = new THREE.PerspectiveCamera(
      options.fov ?? 50,
      (el.clientWidth || 1) / (el.clientHeight || 1),
      options.near ?? 0.1,
      options.far ?? 2000,
    )
    if (options.cameraPos) camera.position.set(...options.cameraPos)
    if (options.lookAt) camera.lookAt(new THREE.Vector3(...options.lookAt))

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = options.shadows ?? false
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    el.appendChild(renderer.domElement)

    ctx.scene = scene
    ctx.camera = camera
    ctx.renderer = renderer

    if (options.controls) {
      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      if (options.lookAt) controls.target.set(...options.lookAt)
      ctx.controls = controls
    }

    update = setup(ctx) ?? undefined
    resize()
    window.addEventListener('resize', resize)

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const dt = clock.getDelta()
      ctx.controls?.update()
      update?.(dt)
      renderer.render(scene, camera)
    }
    if (options.autoLoop !== false) loop()
  })

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', resize)
    ctx.controls?.dispose()
    ctx.renderer?.dispose()
  })

  return ctx
}
