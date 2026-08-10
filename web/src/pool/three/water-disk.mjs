import * as THREE from 'three'
import { POOL_3D_CONFIG } from './config.mjs'

const MAX_IMPACTS = POOL_3D_CONFIG.water.impactSlots
const AMBIENT_IMPACTS = POOL_3D_CONFIG.water.ambientImpactSlots

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
  uniform vec4 uImpacts[${MAX_IMPACTS}];
  uniform float uAmbientImpactLifetime;
  uniform float uSemanticImpactLifetime;
  uniform float uDimpleDuration;
  uniform float uDimpleDisplacement;
  uniform float uImpactAmplitude;
  uniform float uAmbientDisplacement;
  uniform float uSemanticDisplacement;
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
      vec4 impact = uImpacts[i];
      float age = uTime - impact.z;
      float lifetime = i < ${AMBIENT_IMPACTS} ? uAmbientImpactLifetime : uSemanticImpactLifetime;
      float alive = step(0.0, age) * step(age, lifetime);
      float d = distance(p, impact.xy);
      float front = age * uWaveSpeed;
      float delta = d - front;
      float packet = exp(-delta * delta * 2.8) * exp(-(age / max(lifetime, 0.001)) * 1.8);
      float pulse = sin(delta * uWaveNumber) * packet;
      float dimple = exp(-d * d * 72.0) * exp(-age * 12.0) * step(age, uDimpleDuration);
      float displacement = i < ${AMBIENT_IMPACTS} ? uAmbientDisplacement : uSemanticDisplacement;
      h += pulse * impact.w * uImpactAmplitude * displacement * alive * edge;
      h -= dimple * impact.w * uImpactAmplitude * uDimpleDisplacement * alive * edge;
      energy += (abs(pulse) + dimple) * impact.w * alive;
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
  uniform vec4 uImpacts[${MAX_IMPACTS}];
  uniform float uAmbientImpactLifetime;
  uniform float uSemanticImpactLifetime;
  uniform float uWaveSpeed;
  uniform float uRingWidth;
  uniform float uRingIntensity;
  uniform float uSecondaryRingIntensity;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vRippleEnergy;

  float lineRing(float distanceFromImpact, float radius, float width) {
    return 1.0 - smoothstep(width, width * 2.6, abs(distanceFromImpact - radius));
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(vec3(-0.46, 0.86, 0.22));
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 3.2);
    float specular = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), 86.0);
    vec2 surface = vWorldPosition.xz;
    float ringGlow = 0.0;
    for (int i = 0; i < ${MAX_IMPACTS}; i++) {
      vec4 impact = uImpacts[i];
      float age = uTime - impact.z;
      float lifetime = i < ${AMBIENT_IMPACTS} ? uAmbientImpactLifetime : uSemanticImpactLifetime;
      float alive = step(0.0, age) * step(age, lifetime);
      float fade = pow(max(0.0, 1.0 - age / max(lifetime, 0.001)), 1.65);
      float radius = age * uWaveSpeed;
      float distanceFromImpact = distance(surface, impact.xy);
      float primary = lineRing(distanceFromImpact, radius, uRingWidth);
      float secondaryRadius = max(0.0, radius - 0.13);
      float secondary = lineRing(distanceFromImpact, secondaryRadius, uRingWidth * 0.82)
        * step(0.16, radius) * uSecondaryRingIntensity;
      ringGlow += (primary + secondary) * impact.w * fade * alive;
    }

    float centralMirror = exp(-dot(surface, surface) * 0.12);
    vec3 color = mix(uAbyss, uDeepBlue, 0.055 + centralMirror * 0.055 + fresnel * 0.08);
    color += uSteel * fresnel * 0.052;
    color += uPearl * specular * 0.32;
    color += uColdGlint * min(ringGlow * uRingIntensity, 1.35);

    float distanceToCamera = length(cameraPosition - vWorldPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fog, 0.0, 0.35));
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
  // One vec4 per impact keeps the vertex-uniform budget viable on WebGL1:
  // center.xy + time + strength. Lifetime is derived from the fixed partition.
  const impacts = Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector4(999, 999, -999, 0))
  const uniforms = {
    uTime: { value: 0 },
    uRadius: { value: radius },
    uImpacts: { value: impacts },
    uAmbientImpactLifetime: { value: POOL_3D_CONFIG.water.ambientImpactLifetime },
    uSemanticImpactLifetime: { value: POOL_3D_CONFIG.water.semanticImpactLifetime },
    uDimpleDuration: { value: POOL_3D_CONFIG.water.dimpleDuration },
    uDimpleDisplacement: { value: POOL_3D_CONFIG.water.dimpleDisplacement },
    uImpactAmplitude: { value: POOL_3D_CONFIG.water.impactAmplitude },
    uAmbientDisplacement: { value: POOL_3D_CONFIG.water.ambientDisplacement },
    uSemanticDisplacement: { value: POOL_3D_CONFIG.water.semanticDisplacement },
    uWaveSpeed: { value: POOL_3D_CONFIG.water.waveSpeed },
    uWaveNumber: { value: POOL_3D_CONFIG.water.waveNumber },
    uRingWidth: { value: POOL_3D_CONFIG.water.ringWidth },
    uRingIntensity: { value: POOL_3D_CONFIG.water.ringIntensity },
    uSecondaryRingIntensity: { value: POOL_3D_CONFIG.water.secondaryRingIntensity },
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
      impacts[slot].set(
        x,
        z,
        seconds,
        Math.max(0, Math.min(1, strength)),
      )
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}
