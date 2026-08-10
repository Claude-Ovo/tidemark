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

// Rejection sampling against a radial Gaussian produces a soft central rain
// field without a visible circular boundary. Density is per unit area, so the
// result does not secretly encode memory strength or any other data field.
export const seededGaussianDiskSamples = (count, {
  seed = POOL_3D_CONFIG.rain.seed,
  sigma = POOL_3D_CONFIG.rain.sigma,
  maxRadius = POOL_3D_CONFIG.rain.maxRadius,
  centerDensity = POOL_3D_CONFIG.rain.centerDensity,
  edgeDensity = POOL_3D_CONFIG.rain.edgeDensity,
} = {}) => {
  const random = mulberry32(seed)
  const samples = []
  while (samples.length < count) {
    const radius = Math.sqrt(random()) * maxRadius
    const theta = random() * Math.PI * 2
    const gaussian = Math.exp(-((radius / sigma) ** 2))
    const density = edgeDensity + (centerDensity - edgeDensity) * gaussian
    if (random() * centerDensity > density) continue
    samples.push({
      x: radius * Math.cos(theta),
      z: radius * Math.sin(theta),
      intensity: Math.max(0, Math.min(1, gaussian)),
    })
  }
  return samples
}

export const advanceRainDrop = (height, speed, dt, waterHeight = 0.06) => {
  const nextHeight = Number(height) - Number(speed) * Number(dt)
  return nextHeight <= waterHeight
    ? { height: waterHeight, landed: true }
    : { height: nextHeight, landed: false }
}

const vertexShader = /* glsl */`
  attribute float aLength;
  attribute float aOpacity;
  uniform float uViewportHeight;
  uniform float uDropBloom;
  varying float vOpacity;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(aLength * uViewportHeight / max(1.0, -viewPosition.z), 3.0, 22.0);
    vOpacity = aOpacity * uDropBloom;
  }
`

const fragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;

  void main() {
    vec2 point = gl_PointCoord;
    float dx = abs(point.x - 0.5);
    float tail = (1.0 - smoothstep(0.024, 0.066, dx))
      * smoothstep(0.04, 0.20, point.y) * (1.0 - smoothstep(0.84, 0.98, point.y));
    float tip = 1.0 - smoothstep(0.02, 0.065, distance(point, vec2(0.5, 0.84)));
    float alpha = max(tail * (0.30 + point.y * 0.66), tip * 0.62) * vOpacity;
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

const createSplashTexture = () => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 96
  const ctx = canvas.getContext('2d')
  const glow = ctx.createRadialGradient(48, 48, 0, 48, 48, 46)
  glow.addColorStop(0, 'rgba(235,248,255,.7)')
  glow.addColorStop(0.09, 'rgba(205,235,250,.38)')
  glow.addColorStop(0.22, 'rgba(175,215,238,.07)')
  glow.addColorStop(1, 'rgba(175,215,238,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, 96, 96)
  ctx.strokeStyle = 'rgba(220,242,252,.62)'
  ctx.lineWidth = 2.4
  for (const [radius, start, end] of [[19, -0.15, 0.72], [23, 2.2, 3.05], [16, 4.05, 4.72]]) {
    ctx.beginPath()
    ctx.arc(48, 48, radius, start, end)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export const createRainSystem = ({ radius, onImpact } = {}) => {
  const cfg = POOL_3D_CONFIG.rain
  const waterRadius = radius ?? POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale
  const uniforms = {
    uViewportHeight: { value: Math.max(1, window.innerHeight) },
    uDropBloom: { value: cfg.dropBloom },
    uColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  })

  const group = new THREE.Group()
  group.name = 'RainSystem'
  const ambient = createDropPoints(cfg.count, material)
  const directed = createDropPoints(16, material)
  const splashTexture = createSplashTexture()
  const splashGeometry = new THREE.PlaneGeometry(1, 1)
  const splashMaterial = new THREE.MeshBasicMaterial({
    map: splashTexture,
    color: POOL_3D_CONFIG.palette.coldGlint,
    vertexColors: true,
    transparent: true,
    opacity: cfg.impactBloom,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const splashMesh = new THREE.InstancedMesh(splashGeometry, splashMaterial, cfg.splashSlots)
  splashMesh.name = 'RainImpactFlashes'
  splashMesh.count = 0
  splashMesh.frustumCulled = false
  splashMesh.renderOrder = 4
  splashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const splashDummy = new THREE.Object3D()
  const splashColor = new THREE.Color()
  const splashes = Array.from({ length: cfg.splashSlots }, () => null)
  let splashCursor = 0
  group.add(ambient, directed, splashMesh)

  const samples = seededGaussianDiskSamples(cfg.count)
  const random = mulberry32(cfg.seed ^ 0xa53c91e7)
  const positions = ambient.geometry.attributes.position.array
  const lengths = ambient.geometry.attributes.aLength.array
  const opacities = ambient.geometry.attributes.aOpacity.array
  const speeds = new Float32Array(cfg.count)
  const impactStrengths = new Float32Array(cfg.count)
  const respawn = (index, initial = false) => {
    const sample = samples[index]
    positions[index * 3] = sample.x * waterRadius
    positions[index * 3 + 1] = initial
      ? cfg.minHeight + random() * (cfg.maxHeight - cfg.minHeight)
      : cfg.maxHeight + random() * cfg.respawnJitter
    positions[index * 3 + 2] = sample.z * waterRadius
    speeds[index] = cfg.minSpeed + random() * (cfg.maxSpeed - cfg.minSpeed)
    lengths[index] = cfg.minLength + random() * (cfg.maxLength - cfg.minLength)
    opacities[index] = (cfg.edgeOpacity
      + sample.intensity * (cfg.centerOpacity - cfg.edgeOpacity)) * (0.78 + random() * 0.22)
    impactStrengths[index] = cfg.edgeImpact
      + sample.intensity * (cfg.centerImpact - cfg.edgeImpact)
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

  const spawnSplash = (x, z, seconds, strength) => {
    splashes[splashCursor++ % splashes.length] = { x, z, born: seconds, strength }
  }

  const updateSplashes = (seconds) => {
    if (reduced) { splashMesh.count = 0; return }
    let drawIndex = 0
    for (let i = 0; i < splashes.length; i++) {
      const splash = splashes[i]
      if (!splash) continue
      const progress = (seconds - splash.born) / cfg.splashLifetime
      if (progress < 0 || progress >= 1) { splashes[i] = null; continue }
      const fade = (1 - progress) ** 2
      const size = (0.065 + splash.strength * 0.055) + progress * (0.18 + splash.strength * 0.10)
      splashDummy.position.set(splash.x, 0.026, splash.z)
      splashDummy.rotation.set(-Math.PI / 2, 0, 0)
      splashDummy.scale.setScalar(size)
      splashDummy.updateMatrix()
      splashMesh.setMatrixAt(drawIndex, splashDummy.matrix)
      splashColor.setScalar(Math.min(1, fade * (0.42 + splash.strength * 1.15)))
      splashMesh.setColorAt(drawIndex, splashColor)
      drawIndex++
    }
    splashMesh.count = drawIndex
    splashMesh.instanceMatrix.needsUpdate = true
    if (splashMesh.instanceColor) splashMesh.instanceColor.needsUpdate = true
  }

  const setReducedMotion = (value) => {
    reduced = !!value
    ambient.geometry.setDrawRange(0, reduced ? cfg.reducedCount : cfg.count)
    if (reduced) {
      splashes.fill(null)
      splashMesh.count = 0
    }
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
      updateSplashes(seconds)
      if (reduced) { lastSeconds = seconds; return }
      const dt = lastSeconds == null ? 0 : Math.min(0.08, Math.max(0, seconds - lastSeconds))
      lastSeconds = seconds
      if (!dt) return
      for (let i = 0; i < cfg.count; i++) {
        const step = advanceRainDrop(positions[i * 3 + 1], speeds[i], dt)
        positions[i * 3 + 1] = step.height
        if (!step.landed) continue
        const x = positions[i * 3]
        const z = positions[i * 3 + 2]
        spawnSplash(x, z, seconds, impactStrengths[i])
        onImpact?.(x, z, impactStrengths[i], seconds)
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
      splashGeometry.dispose()
      splashMaterial.dispose()
      splashTexture.dispose()
      group.clear()
    },
  }
}
