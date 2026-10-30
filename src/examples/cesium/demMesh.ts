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
export function buildTerrainGeometry(dem: DEM, exag = 1, hOffset = 0): Cesium.Geometry {
  const n = dem.n
  const count = n * n
  const positions = new Float64Array(count * 3)
  const normals = new Float32Array(count * 3)
  const st = new Float32Array(count * 2)
  const indices = new Uint32Array((n - 1) * (n - 1) * 6)

  const tmp = new Cesium.Cartesian3()
  const nrm = new Cesium.Cartesian3()

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

  let p = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = a + n + 1
      indices[p++] = a
      indices[p++] = b
      indices[p++] = c
      indices[p++] = b
      indices[p++] = d
      indices[p++] = c
    }
  }

  return new Cesium.Geometry({
    attributes: geometryAttributes(positions, normals, st),
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
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
