import * as Cesium from 'cesium'
import type { DEM } from '@/examples/shared/terrain'

/* ============================================================
 * DEM → Cesium 可渲染几何
 *
 * Cesium 没有内置"把高程数组直接变成地形三角网"的东西，所以这里自己拼 Geometry：
 *  - position：把每个格点的经纬度 + 高程转成世界坐标（Cartesian3）
 *  - normal ：直接用该点的椭球法线（地表朝上方向），足够材质做光照
 *  - st     ：把画布贴图对齐到格网，u 向东、v 向南；注意 Cesium 材质纹理
 *             flipY=false，t=0 对应画布第一行（北），所以北行 st.y=0
 *  - indices：每格两个三角形，绕序保证法线朝上（(a,b,c) 与 (b,d,c)）
 *
 * 做完后所有"着色"都发生在贴图上（高程分层设色 / 挖填红蓝 / 淹没 / 可视域），
 * 几何只建一次，后续更新只是换材质里的 ImageBitmap —— 不重建图元，自然不会闪。
 * ============================================================ */

/** 组装顶点属性：position 用 double（Cesium 内部会拆成 High/Low 保证精度） */
function geometryAttributes(
  positions: Float64Array,
  normals: Float32Array,
  st: Float32Array,
): Cesium.GeometryAttributes {
  const attr = new Cesium.GeometryAttributes()
  attr.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions,
  })
  attr.normal = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: normals,
  })
  attr.st = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 2,
    values: st,
  })
  return attr
}

/** 地形三角网（世界坐标系），exag 为垂直夸张倍数 */
/**
 * DEM → 世界坐标三角网。
 *
 * @param skirtDepth 裙边深度（米）。> 0 时沿矩形四边向下生成一圈垂直「侧壁」，
 *   把自定义分析块与真实地形（开了全球地形后地表起伏可达数百米）之间的接缝盖住，
 *   否则块体边缘会悬空露出缝、或被山体穿模。Cesium 自带地形也是这么做的（RectangleGeometry 裙边）。
 */
export function buildTerrainGeometry(dem: DEM, exag = 1, hOffset = 0, skirtDepth = 0): Cesium.Geometry {
  const n = dem.n
  const count = n * n
  const skirt = skirtDepth > 0
  const positions = new Float64Array(count * 3)
  const normals = new Float32Array(count * 3)
  const st = new Float32Array(count * 2)
  const indices: number[] = []

  const tmp = new Cesium.Cartesian3()
  const nrm = new Cesium.Cartesian3()

  // 裙边：沿矩形周长一圈的顶点序号（北边→东边→南边→西边），相邻点连成侧壁
  const borderIdx: number[] = []
  if (skirt) {
    for (let i = 0; i < n; i++) borderIdx.push(i) // 北边（j=0）自西向东
    for (let j = 1; j < n - 1; j++) borderIdx.push(j * n + n - 1) // 东边自北向南
    for (let i = n - 1; i >= 0; i--) borderIdx.push((n - 1) * n + i) // 南边自东向西
    for (let j = n - 2; j >= 1; j--) borderIdx.push(j * n) // 西边自南向北
  }
  for (let j = 0; j < n; j++) {
    const v = j / (n - 1)
    const lat = dem.lat1 - (dem.lat1 - dem.lat0) * v
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1)
      const lon = dem.lon0 + (dem.lon1 - dem.lon0) * u
      const hgt = (dem.h[j * n + i] - dem.min) * exag + dem.min + hOffset
      const k = j * n + i
      Cesium.Cartesian3.fromDegrees(lon, lat, hgt, undefined, tmp)
      positions[k * 3] = tmp.x
      positions[k * 3 + 1] = tmp.y
      positions[k * 3 + 2] = tmp.z
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(tmp, nrm)
      normals[k * 3] = nrm.x
      normals[k * 3 + 1] = nrm.y
      normals[k * 3 + 2] = nrm.z
      st[k * 2] = u
      st[k * 2 + 1] = v
    }
  }

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = a + n + 1
      indices.push(a, b, c, b, d, c)
    }
  }

  if (skirt) {
    // 裙边顶点：经纬度同边界点，高度下落 skirtDepth；st 沿用边界点（纹理纵向拉伸，
    // 侧壁呈现边缘像素的延续色，视觉上是「切开的土层」）
    const base = positions.length / 3
    const bottom = new Map<number, number>()
    for (const k of borderIdx) {
      const bi = base + bottom.size
      bottom.set(k, bi)
      positions[bi * 3] = positions[k * 3]
      positions[bi * 3 + 1] = positions[k * 3 + 1]
      positions[bi * 3 + 2] = positions[k * 3 + 2] - skirtDepth
      normals[bi * 3] = normals[k * 3]
      normals[bi * 3 + 1] = normals[k * 3 + 1]
      normals[bi * 3 + 2] = normals[k * 3 + 2]
      st[bi * 2] = st[k * 2]
      st[bi * 2 + 1] = st[k * 2 + 1]
    }
    // 相邻边界点连成四边形；两个绕向都发（省去判断法线朝向，backface 剔除不挑食）
    for (let s = 0; s < borderIdx.length; s++) {
      const a = borderIdx[s]
      const b = borderIdx[(s + 1) % borderIdx.length]
      const aB = bottom.get(a)!
      const bB = bottom.get(b)!
      indices.push(a, b, aB, b, bB, aB)
      indices.push(b, a, bB, a, aB, bB)
    }
  }

  return new Cesium.Geometry({
    attributes: geometryAttributes(positions, normals, st),
    indices: new Uint32Array(indices),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  })
}

/**
 * 独立裙边几何：只有四壁、没有顶面。给「分析块嵌进真实地形」的场景用——
 * 顶面走贴图材质，侧壁配一块深色岩层材质（buildSkirtMaterial），
 * 比把边界像素纵向拉伸成条纹自然得多。
 */
export function buildSkirtGeometry(dem: DEM, exag = 1, hOffset = 0, skirtDepth = 1400): Cesium.Geometry {
  const n = dem.n
  const border: Array<{ lon: number; lat: number; h: number; u: number; v: number }> = []
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1)
    border.push({ lon: dem.lon0 + (dem.lon1 - dem.lon0) * u, lat: dem.lat1, h: dem.h[i], u, v: 0 })
  }
  for (let j = 1; j < n - 1; j++) {
    const v = j / (n - 1)
    border.push({
      lon: dem.lon1,
      lat: dem.lat1 - (dem.lat1 - dem.lat0) * v,
      h: dem.h[j * n + n - 1],
      u: 1,
      v,
    })
  }
  for (let i = n - 1; i >= 0; i--) {
    const u = i / (n - 1)
    const k = (n - 1) * n + i
    border.push({ lon: dem.lon0 + (dem.lon1 - dem.lon0) * u, lat: dem.lat0, h: dem.h[k], u, v: 1 })
  }
  for (let j = n - 2; j >= 1; j--) {
    const v = j / (n - 1)
    border.push({
      lon: dem.lon0,
      lat: dem.lat1 - (dem.lat1 - dem.lat0) * v,
      h: dem.h[j * n],
      u: 0,
      v,
    })
  }

  const m = border.length
  const positions = new Float64Array(m * 2 * 3)
  const normals = new Float32Array(m * 2 * 3)
  const st = new Float32Array(m * 2 * 2)
  const indices = new Uint32Array(m * 12)
  const tmp = new Cesium.Cartesian3()
  const nrm = new Cesium.Cartesian3()
  for (let s = 0; s < m; s++) {
    const b = border[s]
    const hTop = (b.h - dem.min) * exag + dem.min + hOffset
    // 周长参数化坐标 x（沿墙走），y 留给纵向：上缘 0、下缘 1，材质里做层理与向下变暗
    const t = s / m
    // 上缘
    Cesium.Cartesian3.fromDegrees(b.lon, b.lat, hTop, undefined, tmp)
    positions.set([tmp.x, tmp.y, tmp.z], s * 6)
    Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(tmp, nrm)
    normals.set([nrm.x, nrm.y, nrm.z], s * 6)
    st.set([t, 0], s * 4)
    // 下缘（垂直下落 skirtDepth）
    Cesium.Cartesian3.fromDegrees(b.lon, b.lat, hTop - skirtDepth, undefined, tmp)
    positions.set([tmp.x, tmp.y, tmp.z], s * 6 + 3)
    normals.set([nrm.x, nrm.y, nrm.z], s * 6 + 3)
    st.set([t, 1], s * 4 + 2)
  }
  let p = 0
  for (let s = 0; s < m; s++) {
    const s1 = (s + 1) % m
    const aT = s * 2
    const aB = s * 2 + 1
    const bT = s1 * 2
    const bB = s1 * 2 + 1
    indices[p++] = aT
    indices[p++] = bT
    indices[p++] = aB
    indices[p++] = bT
    indices[p++] = bB
    indices[p++] = aB
    indices[p++] = bT
    indices[p++] = aT
    indices[p++] = bB
    indices[p++] = aT
    indices[p++] = aB
    indices[p++] = bB
  }
  return new Cesium.Geometry({
    attributes: geometryAttributes(positions, normals, st),
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  })
}

/** 裙边侧壁材质：岩层断面——水平层理 + 越往下越暗，读起来像「切开的山体」 */
export function makeSkirtMaterial(): Cesium.Material {
  return new Cesium.Material({
    fabric: {
      uniforms: {},
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec2 uv = materialInput.st;
          // 水平层理：沿周长方向轻微起伏 + 纵向多条暗带（模拟岩层/土层）
          float strata = 0.86 + 0.1 * sin(uv.y * 46.0 + sin(uv.x * 26.0) * 1.6);
          // 自上而下逐渐变暗，给侧壁一点体积感
          float depth = mix(1.0, 0.42, smoothstep(0.0, 1.0, uv.y));
          vec3 rock = mix(vec3(0.30, 0.25, 0.19), vec3(0.20, 0.17, 0.13), uv.y);
          m.diffuse = rock * strata * depth;
          m.alpha = 1.0;
          return m;
        }`,
    },
    translucent: false,
  })
}

/** 通用贴图材质：采样一张画布，uniforms.image 可随时换 */
export function makeImageMaterial(
  canvas: HTMLCanvasElement,
  extraUniforms: Record<string, unknown> = {},
  source?: string,
): Cesium.Material {
  return new Cesium.Material({
    fabric: {
      uniforms: { image: canvas, ...extraUniforms },
      source:
        source ??
        `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec4 c = texture(image, materialInput.st);
          m.diffuse = c.rgb;
          m.alpha = c.a;
          return m;
        }`,
    },
    translucent: true,
    minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
    magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
  })
}

/**
 * canvas → ImageBitmap → uniforms.image。
 * 位图已解码完，Cesium 在同一帧内同步建纹理，不会出现 dataURL 那种"空窗帧闪白"。
 * seq 用于丢弃过期结果（拖动滑块时只保留最后一次）。
 */
export function makeTextureUploader(uniformName = 'image') {
  let seq = 0
  let live: ImageBitmap | null = null
  return {
    upload(mat: Cesium.Material | null, canvas: HTMLCanvasElement) {
      if (!mat) return
      const mine = ++seq
      createImageBitmap(canvas).then((bmp) => {
        if (mine !== seq) {
          bmp.close()
          return
        }
        const old = live
        live = bmp
        mat.uniforms[uniformName] = bmp
        old?.close()
      })
    },
    dispose() {
      seq++
      live?.close()
      live = null
    },
  }
}

/** 建一个贴着地表的矩形图元（用于影像/掩膜这类"贴地"图层） */
export function makeRectanglePrimitive(
  dem: DEM,
  mat: Cesium.Material,
  height: number,
): Cesium.Primitive {
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.RectangleGeometry({
        rectangle: Cesium.Rectangle.fromDegrees(dem.lon0, dem.lat0, dem.lon1, dem.lat1),
        height,
        vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: mat,
      translucent: true,
      flat: true,
    }),
    asynchronous: false,
  })
}
