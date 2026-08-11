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
  for (let segment = 0; segment < angular; segment++)
    indices.push(0, vertexAt(1, segment + 1), vertexAt(1, segment))
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
  uniform float uFieldRadius;
  uniform float uHeightScale;
  varying vec2 vFieldUv;
  varying float vFieldMask;
  varying vec3 vWorldPosition;
  void main() {
    vec3 displaced = position;
    vFieldUv = position.xz / (uFieldRadius * 2.0) + 0.5;
    vec2 inside = step(vec2(0.0), vFieldUv) * step(vFieldUv, vec2(1.0));
    vFieldMask = inside.x * inside.y;
    float waveHeight = texture2D(uHeightField, clamp(vFieldUv, 0.0, 1.0)).r * vFieldMask;
    displaced.y += waveHeight * uHeightScale;
    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

// Emergency submission material: the water is intentionally only a quiet
// spatial base. There is no global normal noise, refraction, specular streak,
// caustic, grid or height-field displacement in this final render path.
const fragmentShader = /* glsl */`
  uniform float uTime;
  uniform vec3 uDeepBlue;
  uniform vec3 uColdGlint;
  uniform float uBaseAlpha;
  uniform float uRadius;
  uniform float uEdgeFadeStart;
  uniform sampler2D uHeightField;
  uniform vec2 uHeightTexel;
  uniform vec3 uLightDirection;
  uniform int uMarkCount;
  uniform vec4 uMarks[${MAX_TIDE_MARKS}];
  uniform float uMarkStay;
  uniform float uMarkFade;
  varying vec3 vWorldPosition;
  varying vec2 vFieldUv;
  varying float vFieldMask;

  void main() {
    float depthHint = smoothstep(-uRadius * 0.58, uRadius * 0.72, vWorldPosition.z);
    vec3 color = uDeepBlue * mix(0.72, 1.06, depthHint);
    float alpha = uBaseAlpha * mix(0.68, 1.0, depthHint);

    // All moving detail is derived from the actual fountain-driven field.
    // Quiet regions remain quiet; there is no screen-space or procedural fill.
    vec2 fieldUv = clamp(vFieldUv, 0.0, 1.0);
    float h = texture2D(uHeightField, fieldUv).r;
    float left = texture2D(uHeightField, fieldUv - vec2(uHeightTexel.x, 0.0)).r;
    float right = texture2D(uHeightField, fieldUv + vec2(uHeightTexel.x, 0.0)).r;
    float down = texture2D(uHeightField, fieldUv - vec2(0.0, uHeightTexel.y)).r;
    float up = texture2D(uHeightField, fieldUv + vec2(0.0, uHeightTexel.y)).r;
    vec2 slope = vec2(right - left, up - down) * vFieldMask;
    float waveEnergy = clamp((length(slope) * 760.0 + abs(h) * 48.0) * vFieldMask, 0.0, 1.0);
    vec3 waterNormal = normalize(vec3(-slope.x * 34.0, 1.0, -slope.y * 34.0));
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 reflected = reflect(-normalize(uLightDirection), waterNormal);
    float sparseGlint = pow(max(dot(reflected, viewDirection), 0.0), 30.0) * waveEnergy;
    color += uColdGlint * (sparseGlint * 0.32 + waveEnergy * 0.16);
    alpha += waveEnergy * 0.065;

    // Outcome marks remain local and restrained; recall/remember never write
    // here, so the product rule "result leaves a tide mark" is preserved.
    for (int i = 0; i < ${MAX_TIDE_MARKS}; i++) {
      if (i >= uMarkCount) break;
      vec4 mark = uMarks[i];
      float age = max(0.0, uTime - mark.z);
      float fade = age < uMarkStay ? 1.0 : max(0.0, 1.0 - (age - uMarkStay) / max(uMarkFade, 0.001));
      vec2 delta = vWorldPosition.xz - mark.xy;
      float localMark = exp(-(delta.x * delta.x * 34.0 + delta.y * delta.y * 150.0)) * fade;
      if (mark.w > 0.0) color += uColdGlint * localMark * 0.16;
      else color *= 1.0 - localMark * 0.12;
      alpha += localMark * 0.035;
    }

    float radial = length(vWorldPosition.xz) / uRadius;
    float edgeFade = 1.0 - smoothstep(uEdgeFadeStart, 1.0, radial);
    alpha *= edgeFade;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export const createWaterDisk = ({
  radius = POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale,
  heightField,
  fieldRadius = POOL_3D_CONFIG.worldRadius * 1.25,
} = {}) => {
  if (!heightField) throw new Error('heightfield_required')
  const cfg = POOL_3D_CONFIG.water
  const markVectors = Array.from({ length: MAX_TIDE_MARKS }, () => new THREE.Vector4(999, 999, -999, 0))
  const uniforms = {
    uTime: { value: 0 },
    uDeepBlue: { value: new THREE.Color(POOL_3D_CONFIG.palette.deepBlue) },
    uColdGlint: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
    uBaseAlpha: { value: cfg.baseAlpha },
    uRadius: { value: radius },
    uEdgeFadeStart: { value: cfg.edgeFadeStart },
    uHeightField: { value: heightField.texture },
    uHeightTexel: { value: new THREE.Vector2(1 / heightField.resolution, 1 / heightField.resolution) },
    uFieldRadius: { value: fieldRadius },
    uHeightScale: { value: 0.055 },
    uLightDirection: { value: new THREE.Vector3(-0.32, 0.91, 0.27).normalize() },
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
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: true,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'MinimalTransparentWater'
  mesh.renderOrder = 0

  let frozenSeconds = 0
  let wasReduced = false
  return {
    mesh,
    radius,
    update(seconds, reducedMotion = false) {
      if (reducedMotion) {
        if (!wasReduced) frozenSeconds = uniforms.uTime.value
        uniforms.uTime.value = frozenSeconds
      } else uniforms.uTime.value = seconds
      uniforms.uHeightField.value = heightField.texture
      wasReduced = reducedMotion
    },
    addImpact(x, z, _seconds, strength = 1, kind = 'semantic') {
      const base = kind === 'ambient' ? cfg.ambientImpact : cfg.semanticImpact
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
    metrics() { return { mode: 'fountain-driven-transparent-field', baseAlpha: uniforms.uBaseAlpha.value } },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
