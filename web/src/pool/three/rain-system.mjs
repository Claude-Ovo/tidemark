import * as THREE from 'three'
import { POOL_3D_CONFIG, polarToWorld } from './config.mjs'

const mulberry32 = (seed) => {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Area-uniform disk sampling: a linear radius would visibly bunch rain at the
// centre and falsely make the anchor layer look more active.
export const seededUnitDiskSamples = (count, seed = POOL_3D_CONFIG.rain.seed) => {
  const random = mulberry32(seed)
  return Array.from({ length: count }, () => {
    const radius = Math.sqrt(random())
    const theta = random() * Math.PI * 2
    return { x: radius * Math.cos(theta), z: radius * Math.sin(theta) }
  })
}

const vertexShader = /* glsl */`
  attribute float aLength;
  attribute float aOpacity;
  uniform float uViewportHeight;
  varying float vOpacity;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(aLength * uViewportHeight / max(1.0, -viewPosition.z), 3.0, 22.0);
    vOpacity = aOpacity;
  }
`

const fragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;

  void main() {
    vec2 point = gl_PointCoord;
    float dx = abs(point.x - 0.5);
    float tail = (1.0 - smoothstep(0.055, 0.13, dx))
      * smoothstep(0.04, 0.30, point.y) * (1.0 - smoothstep(0.72, 0.96, point.y));
    float head = 1.0 - smoothstep(0.05, 0.16, distance(point, vec2(0.5, 0.78)));
    float alpha = max(tail * (0.18 + point.y * 0.52), head) * vOpacity;
    if (alpha < 0.015) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const createDropPoints = (count, material) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('aLength', new THREE.BufferAttribute(new Float32Array(count), 1))
  geometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(count), 1))
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  points.renderOrder = 5
  return points
}

export const createRainSystem = ({ radius, onImpact } = {}) => {
  const cfg = POOL_3D_CONFIG.rain
  const waterRadius = radius ?? POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale
  const uniforms = {
    uViewportHeight: { value: Math.max(1, window.innerHeight) },
    uColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.pearl) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    toneMapped: true,
  })

  const group = new THREE.Group()
  group.name = 'RainSystem'
  const ambient = createDropPoints(cfg.count, material)
  const directed = createDropPoints(16, material)
  group.add(ambient, directed)

  const samples = seededUnitDiskSamples(cfg.count)
  const random = mulberry32(cfg.seed ^ 0xa53c91e7)
  const positions = ambient.geometry.attributes.position.array
  const lengths = ambient.geometry.attributes.aLength.array
  const opacities = ambient.geometry.attributes.aOpacity.array
  const speeds = new Float32Array(cfg.count)
  const impactStrengths = new Float32Array(cfg.count)
  const respawn = (index, initial = false) => {
    const sample = samples[index]
    positions[index * 3] = sample.x * waterRadius * cfg.radiusScale
    positions[index * 3 + 1] = initial
      ? cfg.minHeight + random() * (cfg.maxHeight - cfg.minHeight)
      : cfg.maxHeight + random() * 2.4
    positions[index * 3 + 2] = sample.z * waterRadius * cfg.radiusScale
    speeds[index] = cfg.minSpeed + random() * (cfg.maxSpeed - cfg.minSpeed)
    lengths[index] = 0.105 + random() * 0.13
    opacities[index] = 0.16 + random() * 0.32
    impactStrengths[index] = 0.12 + random() * 0.16
  }
  for (let i = 0; i < cfg.count; i++) respawn(i, true)
  ambient.geometry.attributes.position.needsUpdate = true
  ambient.geometry.attributes.aLength.needsUpdate = true
  ambient.geometry.attributes.aOpacity.needsUpdate = true
  ambient.geometry.setDrawRange(0, cfg.count)
  directed.geometry.setDrawRange(0, 0)

  let reduced = false
  let lastSeconds = null
  let rememberDrops = []

  const setReducedMotion = (value) => {
    reduced = !!value
    ambient.geometry.setDrawRange(0, reduced ? cfg.reducedCount : cfg.count)
    if (!reduced) lastSeconds = null
  }

  const syncRememberDrops = (drops) => {
    rememberDrops = drops.slice(0, 16)
  }

  const updateDirected = (seconds) => {
    const attr = directed.geometry.attributes
    const out = attr.position.array
    const outLength = attr.aLength.array
    const outOpacity = attr.aOpacity.array
    const nowMs = seconds * 1000
    let count = 0
    for (const drop of rememberDrops) {
      const age = Math.max(0, nowMs - Number(drop.t0))
      const progress = Math.min(1, age / 380)
      if (progress >= 1) continue
      const point = polarToWorld({ pr: drop.r, theta: drop.theta })
      out[count * 3] = point.x
      out[count * 3 + 1] = point.y + cfg.rememberStartHeight * (1 - progress * progress)
      out[count * 3 + 2] = point.z
      outLength[count] = 0.24
      outOpacity[count] = 0.88
      count++
    }
    directed.geometry.setDrawRange(0, count)
    attr.position.needsUpdate = true
    attr.aLength.needsUpdate = true
    attr.aOpacity.needsUpdate = true
  }

  return {
    group,
    setReducedMotion,
    syncRememberDrops,
    resize(height) { uniforms.uViewportHeight.value = Math.max(1, Number(height) || 1) },
    update(seconds) {
      updateDirected(seconds)
      if (reduced) { lastSeconds = seconds; return }
      const dt = lastSeconds == null ? 0 : Math.min(0.08, Math.max(0, seconds - lastSeconds))
      lastSeconds = seconds
      if (!dt) return
      for (let i = 0; i < cfg.count; i++) {
        positions[i * 3 + 1] -= speeds[i] * dt
        if (positions[i * 3 + 1] > 0.06) continue
        onImpact?.(positions[i * 3], positions[i * 3 + 2], impactStrengths[i])
        respawn(i)
      }
      ambient.geometry.attributes.position.needsUpdate = true
      ambient.geometry.attributes.aLength.needsUpdate = true
      ambient.geometry.attributes.aOpacity.needsUpdate = true
    },
    dispose() {
      ambient.geometry.dispose()
      directed.geometry.dispose()
      material.dispose()
      group.clear()
    },
  }
}
