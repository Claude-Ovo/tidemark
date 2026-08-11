import * as THREE from 'three'
import { POOL_3D_CONFIG } from './config.mjs'
import { selectShaderTideMarks } from './tide-mark-group.mjs'

const MAX_TIDE_MARKS = POOL_3D_CONFIG.water.tideMarkSlots

export const createRadialDiskGeometry = (radius, radialSegments, angularSegments) => {
  const radial = Math.max(2, Math.floor(radialSegments))
  const angular = Math.max(12, Math.floor(angularSegments))
  const positions = [0, 0, 0]
  const uvs = [0.5, 0.5]
  const indices = []
  const vertexAt = (ring, segment) => 1 + (ring - 1) * angular + (segment % angular + angular) % angular

  for (let ring = 1; ring <= radial; ring++) {
    const distance = radius * ring / radial
    for (let segment = 0; segment < angular; segment++) {
      const angle = segment / angular * Math.PI * 2
      const x = Math.cos(angle) * distance
      const z = Math.sin(angle) * distance
      positions.push(x, 0, z)
      uvs.push(x / radius * 0.5 + 0.5, z / radius * 0.5 + 0.5)
    }
  }
  for (let segment = 0; segment < angular; segment++) {
    indices.push(0, vertexAt(1, segment + 1), vertexAt(1, segment))
  }
  for (let ring = 2; ring <= radial; ring++) {
    for (let segment = 0; segment < angular; segment++) {
      const inner = vertexAt(ring - 1, segment)
      const innerNext = vertexAt(ring - 1, segment + 1)
      const outer = vertexAt(ring, segment)
      const outerNext = vertexAt(ring, segment + 1)
      indices.push(inner, outerNext, outer, inner, innerNext, outerNext)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

const vertexShader = /* glsl */`
  uniform sampler2D uHeightField;
  uniform float uHeightScale;
  varying vec2 vSurfaceUv;
  varying vec3 vWorldPosition;

  void main() {
    vSurfaceUv = uv;
    float height = texture2D(uHeightField, uv).r * uHeightScale;
    vec3 displaced = position + vec3(0.0, height, 0.0);
    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */`
  uniform sampler2D uHeightField;
  uniform vec2 uHeightTexel;
  uniform float uHeightScale;
  uniform float uNormalStrength;
  uniform float uTime;
  uniform vec3 uAbyss;
  uniform vec3 uDeepBlue;
  uniform vec3 uSteel;
  uniform vec3 uPearl;
  uniform vec3 uColdGlint;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uRadius;
  uniform float uEdgeFadeStart;
  uniform int uMarkCount;
  uniform vec4 uMarks[${MAX_TIDE_MARKS}];
  uniform float uMarkStay;
  uniform float uMarkFade;
  varying vec2 vSurfaceUv;
  varying vec3 vWorldPosition;

  void main() {
    float left = texture2D(uHeightField, vSurfaceUv - vec2(uHeightTexel.x, 0.0)).r;
    float right = texture2D(uHeightField, vSurfaceUv + vec2(uHeightTexel.x, 0.0)).r;
    float down = texture2D(uHeightField, vSurfaceUv - vec2(0.0, uHeightTexel.y)).r;
    float up = texture2D(uHeightField, vSurfaceUv + vec2(0.0, uHeightTexel.y)).r;
    vec3 localNormal = normalize(vec3(
      (left - right) * uNormalStrength,
      2.0 * uHeightTexel.x / max(uHeightScale, 0.0001),
      (down - up) * uNormalStrength
    ));
    vec3 normal = normalize(mat3(modelMatrix) * localNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(vec3(-0.36, 0.90, 0.24));
    vec3 halfVector = normalize(viewDir + lightDir);
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 3.6);
    float needle = pow(max(dot(normal, halfVector), 0.0), 168.0);
    float broad = pow(max(dot(normal, halfVector), 0.0), 34.0);
    float fieldEnergy = min(1.0, (abs(left - right) + abs(down - up)) * 28.0);

    vec3 markLight = vec3(0.0);
    for (int i = 0; i < ${MAX_TIDE_MARKS}; i++) {
      if (i >= uMarkCount) break;
      vec4 mark = uMarks[i];
      float age = max(0.0, uTime - mark.z);
      float fade = age < uMarkStay ? 1.0 : max(0.0, 1.0 - (age - uMarkStay) / max(uMarkFade, 0.001));
      vec2 delta = vWorldPosition.xz - mark.xy;
      float slash = exp(-(delta.x * delta.x * 68.0 + delta.y * delta.y * 260.0));
      float grain = 0.62 + 0.38 * sin((delta.x * 0.73 + delta.y) * 118.0 + mark.z * 7.0);
      if (mark.w > 0.0) markLight += uColdGlint * slash * grain * fade * 0.42;
      else markLight -= uDeepBlue * slash * fade * 0.22;
    }

    float centralMirror = exp(-dot(vWorldPosition.xz, vWorldPosition.xz) * 0.075);
    vec3 color = mix(uAbyss, uDeepBlue, 0.38 + centralMirror * 0.14 + fresnel * 0.18);
    color += uSteel * (0.018 + fresnel * 0.035);
    color += uPearl * needle * 0.78;
    color += uColdGlint * broad * fieldEnergy * 0.20;
    color += markLight;

    float distanceToCamera = length(cameraPosition - vWorldPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fog, 0.0, 0.34));
    float radial = length(vWorldPosition.xz) / uRadius;
    float edgeAlpha = 1.0 - smoothstep(uEdgeFadeStart, 1.0, radial);
    gl_FragColor = vec4(color, edgeAlpha * 0.97);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export const createWaterDisk = ({
  radius = POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale,
  heightField,
} = {}) => {
  if (!heightField) throw new Error('heightfield_required')
  const markVectors = Array.from({ length: MAX_TIDE_MARKS }, () => new THREE.Vector4(999, 999, -999, 0))
  const uniforms = {
    uHeightField: { value: heightField.texture },
    uHeightTexel: { value: new THREE.Vector2(1 / heightField.resolution, 1 / heightField.resolution) },
    uHeightScale: { value: POOL_3D_CONFIG.water.heightScale },
    uNormalStrength: { value: POOL_3D_CONFIG.water.normalStrength },
    uTime: { value: 0 },
    uAbyss: { value: new THREE.Color(POOL_3D_CONFIG.palette.abyss) },
    uDeepBlue: { value: new THREE.Color(POOL_3D_CONFIG.palette.deepBlue) },
    uSteel: { value: new THREE.Color(POOL_3D_CONFIG.palette.steel) },
    uPearl: { value: new THREE.Color(POOL_3D_CONFIG.palette.pearl) },
    uColdGlint: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
    uFogColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.abyss) },
    uFogDensity: { value: POOL_3D_CONFIG.fogDensity },
    uRadius: { value: radius },
    uEdgeFadeStart: { value: POOL_3D_CONFIG.water.edgeFadeStart },
    uMarkCount: { value: 0 },
    uMarks: { value: markVectors },
    uMarkStay: { value: POOL_3D_CONFIG.tideMark.stayMs / 1000 },
    uMarkFade: { value: POOL_3D_CONFIG.tideMark.fadeMs / 1000 },
  }
  const geometry = createRadialDiskGeometry(
    radius,
    POOL_3D_CONFIG.waterRadialSegments,
    POOL_3D_CONFIG.waterSegments,
  )
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    toneMapped: true,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'HeightFieldWater'
  mesh.renderOrder = 0

  let frozenSeconds = 0
  let wasReduced = false
  return {
    mesh,
    radius,
    update(seconds, reducedMotion = false) {
      uniforms.uHeightField.value = heightField.texture
      if (reducedMotion) {
        if (!wasReduced) frozenSeconds = uniforms.uTime.value
        uniforms.uTime.value = frozenSeconds
      } else uniforms.uTime.value = seconds
      wasReduced = reducedMotion
    },
    addImpact(x, z, _seconds, strength = 1, kind = 'semantic') {
      const base = kind === 'ambient'
        ? POOL_3D_CONFIG.water.ambientImpact
        : POOL_3D_CONFIG.water.semanticImpact
      heightField.addImpact(x, z, Math.max(0.05, Number(strength)) * base)
    },
    syncTideMarks(rings) {
      const marks = selectShaderTideMarks(rings, MAX_TIDE_MARKS)
      uniforms.uMarkCount.value = marks.length
      for (let i = 0; i < MAX_TIDE_MARKS; i++) {
        const mark = marks[i]
        markVectors[i].set(mark?.x ?? 999, mark?.z ?? 999, mark?.born ?? -999, mark?.polarity ?? 0)
      }
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
