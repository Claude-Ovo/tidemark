import * as THREE from 'three'
import { POOL_3D_CONFIG } from './config.mjs'

export const worldToFieldUv = (x, z, radius) => ({
  u: Math.max(0, Math.min(1, Number(x) / (Number(radius) * 2) + 0.5)),
  v: Math.max(0, Math.min(1, Number(z) / (Number(radius) * 2) + 0.5)),
})

// A texel is the simulation's indivisible write unit. Events that land in the
// same texel are summed, never randomly discarded; eventCount remains exact
// while collisionCount === heightfieldStampCount stays auditable upstream.
export const mergeHeightFieldImpulses = (impulses, resolution) => {
  const cells = new Map()
  for (const impulse of impulses) {
    const px = Math.max(0, Math.min(resolution - 1, Math.floor(impulse.u * resolution)))
    const py = Math.max(0, Math.min(resolution - 1, Math.floor(impulse.v * resolution)))
    const key = `${px}|${py}`
    const current = cells.get(key)
    if (current) {
      current.strength += impulse.strength
      current.radius = Math.max(current.radius, impulse.radius)
      current.eventCount += impulse.eventCount ?? 1
    } else {
      cells.set(key, {
        u: (px + 0.5) / resolution,
        v: (py + 0.5) / resolution,
        strength: Number(impulse.strength),
        radius: Number(impulse.radius),
        eventCount: impulse.eventCount ?? 1,
      })
    }
  }
  return [...cells.values()]
}

const fullscreenVertex = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const simulationFragment = (maxImpulses) => /* glsl */`
  precision highp float;
  uniform sampler2D uPrevious;
  uniform vec2 uTexel;
  uniform float uDt;
  uniform float uWaveCoefficient;
  uniform float uDamping;
  uniform float uBoundaryAbsorption;
  uniform int uImpulseCount;
  uniform vec4 uImpulses[${maxImpulses}];
  varying vec2 vUv;

  void main() {
    vec4 state = texture2D(uPrevious, vUv);
    float height = state.r;
    float velocity = state.g;
    float left = texture2D(uPrevious, vUv - vec2(uTexel.x, 0.0)).r;
    float right = texture2D(uPrevious, vUv + vec2(uTexel.x, 0.0)).r;
    float down = texture2D(uPrevious, vUv - vec2(0.0, uTexel.y)).r;
    float up = texture2D(uPrevious, vUv + vec2(0.0, uTexel.y)).r;
    float laplacian = left + right + down + up - 4.0 * height;

    velocity += laplacian * uWaveCoefficient * uDt;
    for (int i = 0; i < ${maxImpulses}; i++) {
      if (i >= uImpulseCount) break;
      vec4 impulse = uImpulses[i];
      vec2 delta = vUv - impulse.xy;
      float radius = max(impulse.z, 0.0001);
      velocity += exp(-dot(delta, delta) / (radius * radius)) * impulse.w;
    }

    float edge = smoothstep(0.70, 0.985, length((vUv - 0.5) * 2.0));
    velocity *= exp(-(uDamping + edge * uBoundaryAbsorption) * uDt);
    height = (height + velocity * uDt) * exp(-edge * uBoundaryAbsorption * 0.22 * uDt);
    gl_FragColor = vec4(height, velocity, 0.0, 1.0);
  }
`

const makeTarget = (resolution) => {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.generateMipmaps = false
  return target
}

export const createHeightField = ({ renderer, radius, resolution = POOL_3D_CONFIG.water.heightFieldResolution } = {}) => {
  if (!renderer?.capabilities?.isWebGL2) throw new Error('heightfield_requires_webgl2')
  const cfg = POOL_3D_CONFIG.water
  const size = Math.max(128, Math.floor(Number(resolution) || cfg.heightFieldResolution))
  const maxImpulses = cfg.maxImpulsesPerFrame
  let read = makeTarget(size)
  let write = makeTarget(size)
  const impulses = Array.from({ length: maxImpulses }, () => new THREE.Vector4(-1, -1, 0, 0))
  const uniforms = {
    uPrevious: { value: read.texture },
    uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
    uDt: { value: cfg.simulationStep },
    uWaveCoefficient: { value: cfg.waveCoefficient },
    uDamping: { value: cfg.damping },
    uBoundaryAbsorption: { value: cfg.boundaryAbsorption },
    uImpulseCount: { value: 0 },
    uImpulses: { value: impulses },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: fullscreenVertex,
    fragmentShader: simulationFragment(maxImpulses),
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const previousTarget = renderer.getRenderTarget()
  const previousColor = renderer.getClearColor(new THREE.Color()).clone()
  const previousAlpha = renderer.getClearAlpha()
  renderer.setClearColor(0x000000, 0)
  for (const target of [read, write]) {
    renderer.setRenderTarget(target)
    renderer.clear(true, false, false)
  }
  renderer.setRenderTarget(previousTarget)
  renderer.setClearColor(previousColor, previousAlpha)

  let pending = []
  let lastSeconds = null
  let committedImpactCount = 0
  let visualImpactCount = 0

  const renderStep = (dt, batch) => {
    uniforms.uPrevious.value = read.texture
    uniforms.uDt.value = dt
    uniforms.uImpulseCount.value = batch.length
    for (let i = 0; i < maxImpulses; i++) {
      const impulse = batch[i]
      impulses[i].set(
        impulse?.u ?? -1,
        impulse?.v ?? -1,
        impulse?.radius ?? 0,
        impulse?.strength ?? 0,
      )
    }
    const targetBefore = renderer.getRenderTarget()
    renderer.setRenderTarget(write)
    renderer.render(scene, camera)
    renderer.setRenderTarget(targetBefore)
    ;[read, write] = [write, read]
  }

  return {
    get texture() { return read.texture },
    resolution: size,
    addImpact(x, z, strength = 1) {
      const uv = worldToFieldUv(x, z, radius)
      pending.push({
        ...uv,
        strength: Number(strength),
        radius: cfg.impulseRadius,
        eventCount: 1,
      })
      committedImpactCount++
    },
    update(seconds, reducedMotion = false) {
      const elapsed = lastSeconds == null
        ? 0
        : Math.min(0.05, Math.max(0, seconds - lastSeconds))
      lastSeconds = seconds
      const merged = mergeHeightFieldImpulses(pending, size)
      const batch = merged.slice(0, maxImpulses)
      pending = merged.slice(maxImpulses)
      visualImpactCount += batch.reduce((sum, impulse) => sum + impulse.eventCount, 0)
      if (reducedMotion) {
        if (batch.length) renderStep(cfg.simulationStep, batch)
        return
      }
      if (elapsed === 0) {
        if (batch.length) renderStep(cfg.simulationStep, batch)
        return
      }
      const steps = Math.max(1, Math.ceil(elapsed / cfg.simulationStep))
      const dt = elapsed / steps
      for (let i = 0; i < steps; i++) renderStep(dt, i === 0 ? batch : [])
    },
    metrics() {
      return {
        heightfieldStampCount: committedImpactCount,
        committedImpactCount,
        visualImpactCount,
        queuedImpactCount: pending.reduce((n, x) => n + x.eventCount, 0),
      }
    },
    dispose() {
      read.dispose()
      write.dispose()
      quad.geometry.dispose()
      material.dispose()
      scene.clear()
      pending = []
    },
  }
}
