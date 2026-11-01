/** 原生 WebGL 示例的公共工具：上下文初始化、着色器编译、简单矩阵运算 */

export interface GLContext {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  resize: () => void
}

/** 在容器内创建 canvas 与 WebGL 上下文，并处理尺寸自适应 */
export function setupGL(el: HTMLDivElement): GLContext | null {
  const canvas = document.createElement('canvas')
  el.appendChild(canvas)
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'

  const gl = canvas.getContext('webgl', { antialias: true, alpha: false })
  if (!gl) {
    console.error('当前环境不支持 WebGL')
    return null
  }

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = el.clientWidth || 1
    const h = el.clientHeight || 1
    canvas.width = Math.max(1, Math.floor(w * dpr))
    canvas.height = Math.max(1, Math.floor(h * dpr))
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  resize()

  return { canvas, gl, resize }
}

export function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('着色器编译失败：', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export function createProgram(
  gl: WebGLRenderingContext,
  vsSource: string,
  fsSource: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource)
  if (!vs || !fs) return null
  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('程序链接失败：', gl.getProgramInfoLog(program))
    return null
  }
  return program
}

/* ---------------- 4x4 矩阵（列主序，可直接传给 uniformMatrix4fv） ---------------- */
export type Mat4 = Float32Array
export type Mat3 = Float32Array

export function identity(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + j] * b[i * 4 + k]
      out[i * 4 + j] = sum
    }
  }
  return out
}

export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}

export function lookAt(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number],
): Mat4 {
  const [ex, ey, ez] = eye
  const [cx, cy, cz] = center
  let zx = ex - cx
  let zy = ey - cy
  let zz = ez - cz
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len
  zy /= len
  zz /= len

  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  len = Math.hypot(xx, xy, xz) || 1
  xx /= len
  xy /= len
  xz /= len

  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * ex + xy * ey + xz * ez),
    -(yx * ex + yy * ey + yz * ez),
    -(zx * ex + zy * ey + zz * ez),
    1,
  ])
}

export function rotationY(angle: number): Mat4 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])
}

export function rotationX(angle: number): Mat4 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
}

export function scaling(s: number): Mat4 {
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1])
}

export function translation(x: number, y: number, z: number): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
}

/** 取模型矩阵左上 3x3 作为法线矩阵（仅含旋转与等比缩放时成立） */
export function normalMat3(m: Mat4): Mat3 {
  return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
}

/** 生成 UV 球体：位置、法线、索引 */
export function createSphere(
  segments = 48,
  rings = 32,
): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  for (let y = 0; y <= rings; y++) {
    const v = y / rings
    const phi = v * Math.PI
    for (let x = 0; x <= segments; x++) {
      const u = x / segments
      const theta = u * Math.PI * 2
      const nx = Math.sin(phi) * Math.cos(theta)
      const ny = Math.cos(phi)
      const nz = Math.sin(phi) * Math.sin(theta)
      positions.push(nx, ny, nz)
      normals.push(nx, ny, nz)
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x
      const b = a + segments + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  }
}

/** 生成立方体：位置、法线、索引（单位立方体，边长 2） */
export function createCube(): {
  positions: Float32Array
  normals: Float32Array
  indices: Uint16Array
} {
  const faces: { n: [number, number, number]; v: [number, number, number][] }[] = [
    { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ]
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  faces.forEach((face, i) => {
    face.v.forEach((p) => {
      positions.push(...p)
      normals.push(...face.n)
    })
    const b = i * 4
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
  })
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  }
}

/* ---------------- 全屏四边形与离屏渲染（后处理示例共用） ---------------- */

/** 全屏四边形（TRIANGLE_STRIP），顶点属性名用 aPos，取值 [-1,1] */
export function createQuad(gl: WebGLRenderingContext): WebGLBuffer | null {
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  return buf
}

export interface Framebuffer {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
  depth: WebGLRenderbuffer | null
  width: number
  height: number
}

/**
 * 建一个离屏帧缓冲：颜色挂纹理（后续可当 sampler2D 采样），可选 16 位深度。
 * WebGL1 的纹理必须 NPOT 友好，所以统一 CLAMP_TO_EDGE + LINEAR、不生成 mipmap。
 */
export function createFramebuffer(
  gl: WebGLRenderingContext,
  width: number,
  height: number,
  depth = true,
): Framebuffer {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)

  let depthBuf: WebGLRenderbuffer | null = null
  if (depth) {
    depthBuf = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuf)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuf)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { fbo, tex, depth: depthBuf, width, height }
}

/** 尺寸变化时重建附件（canvas 尺寸随窗口变，FBO 也要跟着变） */
export function resizeFramebuffer(
  gl: WebGLRenderingContext,
  fb: Framebuffer,
  width: number,
  height: number,
): void {
  if (fb.width === width && fb.height === height) return
  fb.width = width
  fb.height = height
  gl.bindTexture(gl.TEXTURE_2D, fb.tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  if (fb.depth) {
    gl.bindRenderbuffer(gl.RENDERBUFFER, fb.depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height)
  }
}

export function deleteFramebuffer(gl: WebGLRenderingContext, fb: Framebuffer | null): void {
  if (!fb) return
  gl.deleteTexture(fb.tex)
  if (fb.depth) gl.deleteRenderbuffer(fb.depth)
  gl.deleteFramebuffer(fb.fbo)
}

/** 绑定离屏（或 null 表示屏幕）并设置视口 */
export function bindFramebuffer(
  gl: WebGLRenderingContext,
  fb: Framebuffer | null,
  screenW: number,
  screenH: number,
): void {
  if (fb) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fbo)
    gl.viewport(0, 0, fb.width, fb.height)
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, screenW, screenH)
  }
}

/** canvas → 纹理（注意 FLIP_Y：canvas 第 0 行在顶部，纹理 v=0 在底部） */
export function textureFromCanvas(
  gl: WebGLRenderingContext,
  canvas: HTMLCanvasElement,
  flipY = true,
): WebGLTexture {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}
