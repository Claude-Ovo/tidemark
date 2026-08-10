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
    gl_PointSize = clamp(aLength * uViewportHeight / max(1.0, -viewPosition.z), 4.0, 34.0);
    vOpacity = aOpacity;
  }
`

const fragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;

  void main() {
    vec2 point = gl_PointCoord;
    float dx = abs(point.x - 0.5);
    float tail = (1.0 - smoothstep(0.028, 0.078, dx))
      * smoothstep(0.02, 0.16, point.y) * (1.0 - smoothstep(0.88, 0.99, point.y));
    float tip = 1.0 - smoothstep(0.025, 0.082, distance(point, vec2(0.5, 0.86)));
    float alpha = max(tail * (0.22 + point.y * 0.70), tip * 0.72) * vOpacity;
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
  ctx.beginPath()
  ctx.arc(48, 48, 25, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(220,242,252,.72)'
  ctx.lineWidth = 3
  ctx.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
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
  const splashTexture = createSplashTexture()
  const splashGeometry = new THREE.PlaneGeometry(1, 1)
  const splashMaterial = new THREE.MeshBasicMaterial({
    map: splashTexture,
    color: POOL_3D_CONFIG.palette.coldGlint,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
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

  const samples = seededUnitDiskSamples(cfg.count)
  const random = mulberry32(cfg.seed ^ 0xa53c91e7)
  const positions = ambient.geometry.attributes.position.array
  const lengths = ambient.geometry.attributes.aLength.array
  const opacities = ambient.geometry.attributes.aOpacity.array
  const speeds = new Float32Array(cfg.count)
  const impactStrengths = new Float32Array(cfg.count)
  const landingCycles = new Uint32Array(cfg.count)
  const respawn = (index, initial = false) => {
    const sample = samples[index]
    positions[index * 3] = sample.x * waterRadius * cfg.radiusScale
    positions[index * 3 + 1] = initial
      ? cfg.minHeight + random() * (cfg.maxHeight - cfg.minHeight)
      : cfg.maxHeight + random() * 2.4
    positions[index * 3 + 2] = sample.z * waterRadius * cfg.radiusScale
    speeds[index] = cfg.minSpeed + random() * (cfg.maxSpeed - cfg.minSpeed)
    lengths[index] = 0.24 + random() * 0.28
    opacities[index] = 0.28 + random() * 0.38
    impactStrengths[index] = 0.16 + random() * 0.20
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
      const size = (0.10 + splash.strength * 0.10) + progress * (0.34 + splash.strength * 0.20)
      splashDummy.position.set(splash.x, 0.026, splash.z)
      splashDummy.rotation.set(-Math.PI / 2, 0, 0)
      splashDummy.scale.setScalar(size)
      splashDummy.updateMatrix()
      splashMesh.setMatrixAt(drawIndex, splashDummy.matrix)
      splashColor.setScalar(Math.min(1, fade * (0.55 + splash.strength * 1.5)))
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
        positions[i * 3 + 1] -= speeds[i] * dt
        if (positions[i * 3 + 1] > 0.06) continue
        const x = positions[i * 3]
        const z = positions[i * 3 + 2]
        spawnSplash(x, z, seconds, impactStrengths[i])
        landingCycles[i]++
        if ((i + landingCycles[i]) % cfg.waterImpactStride === 0) {
          onImpact?.(x, z, impactStrengths[i])
        }
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
