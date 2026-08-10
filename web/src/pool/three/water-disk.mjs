import * as THREE from 'three'
import { POOL_3D_CONFIG } from './config.mjs'

const MAX_IMPACTS = POOL_3D_CONFIG.water.impactSlots

// Ambient rain is intentionally noisy, while recall/remember/click impacts carry
// product meaning. Separate rings prevent a storm from evicting a semantic wave
// before its configured lifetime has elapsed.
export const createImpactSlotAllocator = ({ ambientSlots, semanticSlots }) => {
  if (!Number.isInteger(ambientSlots) || ambientSlots < 1
      || !Number.isInteger(semanticSlots) || semanticSlots < 1) {
    throw new Error('impact slot partitions must be positive integers')
  }
  let ambientCursor = 0
  let semanticCursor = 0
  return {
    total: ambientSlots + semanticSlots,
    next(kind = 'semantic') {
      if (kind === 'ambient') return ambientCursor++ % ambientSlots
      if (kind === 'semantic') return ambientSlots + semanticCursor++ % semanticSlots
      throw new Error(`unknown impact kind: ${kind}`)
    },
  }
}

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
  uniform float uTime;
  uniform float uRadius;
  uniform vec2 uImpactCenters[${MAX_IMPACTS}];
  uniform float uImpactTimes[${MAX_IMPACTS}];
  uniform float uImpactStrengths[${MAX_IMPACTS}];
  uniform float uImpactLifetime;
  uniform float uWaveSpeed;
  uniform float uWaveNumber;
  uniform float uAmbientAmplitude;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vRippleEnergy;

  float waterHeight(vec2 p, out float energy) {
    float edge = 1.0 - smoothstep(uRadius * 0.78, uRadius, length(p));
    float h = (sin(p.x * 1.16 + p.y * 0.24 + uTime * 0.20)
      + sin(p.y * 0.91 - p.x * 0.18 - uTime * 0.16)) * uAmbientAmplitude;
    energy = 0.0;
    for (int i = 0; i < ${MAX_IMPACTS}; i++) {
      float age = uTime - uImpactTimes[i];
      float alive = step(0.0, age) * step(age, uImpactLifetime);
      float d = distance(p, uImpactCenters[i]);
      float front = age * uWaveSpeed;
      float delta = d - front;
      float packet = exp(-delta * delta * 1.28) * exp(-age * 0.24);
      float pulse = sin(delta * uWaveNumber) * packet;
      h += pulse * uImpactStrengths[i] * alive * edge;
      energy += abs(pulse) * uImpactStrengths[i] * alive;
    }
    return h * edge;
  }

  void main() {
    vec3 displaced = position;
    float eps = 0.035;
    float energy;
    float unusedEnergy;
    float h = waterHeight(position.xz, energy);
    float hx = waterHeight(position.xz + vec2(eps, 0.0), unusedEnergy);
    float hz = waterHeight(position.xz + vec2(0.0, eps), unusedEnergy);
    displaced.y += h;
    vec3 localNormal = normalize(vec3(h - hx, eps, h - hz));
    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vWorldPosition = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * localNormal);
    vRippleEnergy = energy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */`
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
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vRippleEnergy;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), f.x),
      mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0)), f.x),
      f.y
    );
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(vec3(-0.46, 0.86, 0.22));
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 3.2);
    float specular = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), 86.0);
    vec2 surface = vWorldPosition.xz;
    float coarse = valueNoise(surface * 0.42 + vec2(uTime * 0.018, -uTime * 0.012));
    float fine = valueNoise(surface * 1.13 + vec2(-uTime * 0.025, uTime * 0.019));
    vec2 horizontalView = normalize(viewDir.xz + vec2(0.0001));
    vec2 bandDirection = normalize(vec2(0.96, 0.28) + horizontalView * 0.18);
    float irregularBand = dot(surface, bandDirection) * 0.15
      + (coarse - 0.5) * 0.74 + (fine - 0.5) * 0.22 - sin(uTime * 0.045) * 0.31;
    float bandWidth = mix(4.1, 10.8, 0.5 + 0.5 * dot(horizontalView, bandDirection));
    bandWidth *= mix(0.72, 1.22, coarse);
    float pearlBand = exp(-irregularBand * irregularBand * bandWidth)
      * smoothstep(0.22, 0.78, fine) * (0.08 + fresnel * 0.54);
    float quietVariation = valueNoise(surface * 0.28 + vec2(uTime * 0.01));

    vec3 color = mix(uAbyss, uDeepBlue, 0.50 + quietVariation * 0.14);
    color = mix(color, uSteel, fresnel * 0.18);
    color += uPearl * pearlBand * 0.20;
    color += uColdGlint * specular * 0.72;
    color += uColdGlint * min(vRippleEnergy * 3.4, 1.0) * 0.17;

    float distanceToCamera = length(cameraPosition - vWorldPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fog, 0.0, 0.82));
    float radial = length(vWorldPosition.xz) / uRadius;
    float edgeAlpha = 1.0 - smoothstep(uEdgeFadeStart, 1.0, radial);
    gl_FragColor = vec4(color, edgeAlpha * 0.96);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export const createWaterDisk = ({ radius = POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale } = {}) => {
  const allocator = createImpactSlotAllocator({
    ambientSlots: POOL_3D_CONFIG.water.ambientImpactSlots,
    semanticSlots: POOL_3D_CONFIG.water.semanticImpactSlots,
  })
  if (allocator.total !== MAX_IMPACTS) throw new Error('impact slot partitions must fill impactSlots')
  const centers = Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector2(999, 999))
  const times = Array.from({ length: MAX_IMPACTS }, () => -999)
  const strengths = Array.from({ length: MAX_IMPACTS }, () => 0)
  const uniforms = {
    uTime: { value: 0 },
    uRadius: { value: radius },
    uImpactCenters: { value: centers },
    uImpactTimes: { value: times },
    uImpactStrengths: { value: strengths },
    uImpactLifetime: { value: POOL_3D_CONFIG.water.impactLifetime },
    uWaveSpeed: { value: POOL_3D_CONFIG.water.waveSpeed },
    uWaveNumber: { value: POOL_3D_CONFIG.water.waveNumber },
    uAmbientAmplitude: { value: POOL_3D_CONFIG.water.ambientAmplitude },
    uAbyss: { value: new THREE.Color(POOL_3D_CONFIG.palette.abyss) },
    uDeepBlue: { value: new THREE.Color(POOL_3D_CONFIG.palette.deepBlue) },
    uSteel: { value: new THREE.Color(POOL_3D_CONFIG.palette.steel) },
    uPearl: { value: new THREE.Color(POOL_3D_CONFIG.palette.pearl) },
    uColdGlint: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
    uFogColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.abyss) },
    uFogDensity: { value: POOL_3D_CONFIG.fogDensity },
    uEdgeFadeStart: { value: POOL_3D_CONFIG.water.edgeFadeStart },
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
  mesh.name = 'WaterDisk'
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
      } else {
        uniforms.uTime.value = seconds
      }
      wasReduced = reducedMotion
    },
    addImpact(x, z, seconds, strength = 1, kind = 'semantic') {
      const slot = allocator.next(kind)
      centers[slot].set(x, z)
      times[slot] = seconds
      strengths[slot] = Math.max(0, Math.min(1, strength)) * POOL_3D_CONFIG.water.impactAmplitude
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}
