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
  uniform sampler2D uSceneColor;
  uniform vec2 uHeightTexel;
  uniform vec2 uViewportSize;
  uniform float uHeightScale;
  uniform float uNormalStrength;
  uniform float uTime;
  uniform float uIor;
  uniform float uF0;
  uniform float uTransmission;
  uniform float uRoughness;
  uniform float uRefractionStrength;
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
    // Three low-amplitude directional wave families keep the surface alive
    // without adding fake collision rings or changing the event height field.
    vec2 surface = vWorldPosition.xz;
    vec2 microSlope = vec2(0.0);
    microSlope += vec2(0.0032, 0.0018) * sin(dot(surface, vec2(7.4, 2.2)) + uTime * 1.16);
    microSlope += vec2(-0.0017, 0.0028) * sin(dot(surface, vec2(-4.8, 11.5)) + uTime * 0.83);
    microSlope += vec2(0.0014, -0.0018) * sin(dot(surface, vec2(16.8, -6.4)) + uTime * 1.47);
    vec3 normal = normalize(vec3(localNormal.x + microSlope.x, localNormal.y, localNormal.z + microSlope.y));
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(vec3(-0.36, 0.90, 0.24));
    vec3 halfVector = normalize(viewDir + lightDir);
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = uF0 + (1.0 - uF0) * pow(1.0 - facing, 5.0);
    float needle = pow(max(dot(normal, halfVector), 0.0), mix(230.0, 92.0, uRoughness));
    float broad = pow(max(dot(normal, halfVector), 0.0), mix(58.0, 24.0, uRoughness));
    float fieldEnergy = min(1.0, (abs(left - right) + abs(down - up)) * 1400.0);

    vec2 screenUv = clamp(gl_FragCoord.xy / max(uViewportSize, vec2(1.0)), vec2(0.002), vec2(0.998));
    float etaBend = 1.0 - 1.0 / max(uIor, 1.001);
    vec2 refractOffset = normal.xz * uRefractionStrength * etaBend * 4.0 * (1.0 - fresnel * 0.72);
    vec3 refracted;
    refracted.r = texture2D(uSceneColor, clamp(screenUv + refractOffset * 1.08, vec2(0.002), vec2(0.998))).r;
    refracted.g = texture2D(uSceneColor, clamp(screenUv + refractOffset, vec2(0.002), vec2(0.998))).g;
    refracted.b = texture2D(uSceneColor, clamp(screenUv + refractOffset * 0.92, vec2(0.002), vec2(0.998))).b;

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

    float transmission = uTransmission * (1.0 - fresnel * 0.68);
    vec3 color = refracted * transmission * vec3(0.72, 0.86, 0.94);
    color += uDeepBlue * (0.055 + (1.0 - transmission) * 0.10);
    color += uSteel * (0.008 + fresnel * 0.18);

    // Thin, discontinuous specular fragments replace the former handful of
    // broad soft rings. The height field still supplies every real collision.
    vec2 shardUv = surface * vec2(3.3, 7.4) + vec2(uTime * 0.16, 0.0);
    vec2 shardCell = floor(shardUv);
    vec2 shardLocal = fract(shardUv) - 0.5;
    float shardRandom = fract(sin(dot(shardCell, vec2(127.1, 311.7))) * 43758.5453123);
    shardLocal.x += (shardRandom - 0.5) * 0.48;
    float shortDash = (1.0 - smoothstep(0.20, 0.46, abs(shardLocal.x)))
      * (1.0 - smoothstep(0.035, 0.095, abs(shardLocal.y)));
    float shardMask = shortDash * step(0.44, shardRandom);
    float broken = shardMask * (0.24 + fieldEnergy * 0.76);
    color += uPearl * needle * broken * 0.76;
    color += uColdGlint * broad * broken * (0.055 + fieldEnergy * 0.48);
    color += uColdGlint * broken * (0.020 + fieldEnergy * 0.55);
    color += uColdGlint * fieldEnergy * (0.006 + fresnel * 0.025);
    color += markLight;

    float distanceToCamera = length(cameraPosition - vWorldPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fog, 0.0, 0.34));
    float radial = length(vWorldPosition.xz) / uRadius;
    float edgeReveal = 1.0 - smoothstep(uEdgeFadeStart, 1.0, radial);
    color = mix(refracted, color, edgeReveal);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export const createWaterDisk = ({
  radius = POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale,
  heightField,
} = {}) => {
  if (!heightField) throw new Error('heightfield_required')
  const fallbackScene = new THREE.DataTexture(new Uint8Array([2, 6, 10, 255]), 1, 1, THREE.RGBAFormat)
  fallbackScene.needsUpdate = true
  const markVectors = Array.from({ length: MAX_TIDE_MARKS }, () => new THREE.Vector4(999, 999, -999, 0))
  const uniforms = {
    uHeightField: { value: heightField.texture },
    uSceneColor: { value: fallbackScene },
    uHeightTexel: { value: new THREE.Vector2(1 / heightField.resolution, 1 / heightField.resolution) },
    uViewportSize: { value: new THREE.Vector2(1, 1) },
    uHeightScale: { value: POOL_3D_CONFIG.water.heightScale },
    uNormalStrength: { value: POOL_3D_CONFIG.water.normalStrength },
    uTime: { value: 0 },
    uIor: { value: POOL_3D_CONFIG.water.ior },
    uF0: { value: POOL_3D_CONFIG.water.f0 },
    uTransmission: { value: POOL_3D_CONFIG.water.transmission },
    uRoughness: { value: POOL_3D_CONFIG.water.roughness },
    uRefractionStrength: { value: POOL_3D_CONFIG.water.refractionStrength },
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
    transparent: false,
    depthWrite: true,
    blending: THREE.NoBlending,
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
    setSceneColor(texture, width, height) {
      uniforms.uSceneColor.value = texture ?? fallbackScene
      uniforms.uViewportSize.value.set(Math.max(1, width), Math.max(1, height))
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
    metrics() {
      return {
        ior: POOL_3D_CONFIG.water.ior,
        f0: uniforms.uF0.value,
        transmission: uniforms.uTransmission.value,
        roughness: uniforms.uRoughness.value,
      }
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      fallbackScene.dispose()
    },
  }
}
