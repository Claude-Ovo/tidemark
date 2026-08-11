import * as THREE from 'three'
import { POOL_3D_CONFIG } from './config.mjs'

const TAU = Math.PI * 2
const hash01 = (value) => {
  const x = Math.sin(value * 91.3458 + 12.345) * 47453.5453
  return x - Math.floor(x)
}

export const createNozzleLayout = (cfg = POOL_3D_CONFIG.fountain) => {
  const ring = (count, radius, height, tier) => Array.from({ length: count }, (_, index) => {
    const angle = index / count * TAU
    const variation = (hash01(index + tier * 131) * 2 - 1) * cfg.heightVariation
    return {
      tier,
      index,
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      height: height * (1 + variation),
      phase: hash01(index * 3.17 + tier * 17),
    }
  })
  return [
    ...ring(cfg.innerNozzles, cfg.innerRadius, cfg.innerHeight, 0),
    ...ring(cfg.activeNozzles, cfg.activeRadius, cfg.innerHeight * cfg.activeHeightRatio, 1),
  ]
}

const vertexShader = /* glsl */`
  attribute vec2 aBase;
  attribute float aAlong;
  attribute float aHeight;
  attribute float aPhase;
  attribute float aTier;
  attribute float aSeed;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uMotion;
  varying float vAlong;
  varying float vAlpha;

  void main() {
    float along = 0.66 + fract(aAlong + uTime * uMotion * (0.92 + aSeed * 0.14) + aPhase) * 0.34;
    float top = smoothstep(0.72, 1.0, along);
    float breakup = top * top;
    vec2 jitter = vec2(
      sin(aSeed * 71.0 + along * 31.0 + uTime * 4.2),
      cos(aSeed * 53.0 + along * 27.0 + uTime * 3.7)
    ) * breakup * mix(0.018, 0.026, aTier);
    vec3 worldPosition = vec3(aBase.x + jitter.x, 0.045 + along * aHeight, aBase.y + jitter.y);
    vec4 viewPosition = modelViewMatrix * vec4(worldPosition, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = mix(4.6, 3.8, aTier) * uPixelRatio * mix(1.0, 0.76, top);
    vAlong = along;
    vAlpha = mix(0.62, 0.24, top) * (0.86 + aSeed * 0.14);
  }
`

const fragmentShader = /* glsl */`
  uniform vec3 uWaterColor;
  varying float vAlong;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float radial = length(vec2(p.x * 1.08, p.y)) * 2.0;
    float alpha = (1.0 - smoothstep(0.72, 1.0, radial)) * vAlpha;
    if (alpha < 0.012) discard;
    gl_FragColor = vec4(uWaterColor, alpha);
    #include <colorspace_fragment>
  }
`

const streamVertexShader = /* glsl */`
  attribute float aLineAlong;
  attribute float aTier;
  varying float vLineAlong;
  varying float vLineTier;
  void main() {
    vLineAlong = aLineAlong;
    vLineTier = aTier;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const streamFragmentShader = /* glsl */`
  uniform vec3 uWaterColor;
  varying float vLineAlong;
  varying float vLineTier;
  void main() {
    float topFade = 1.0 - smoothstep(0.62, 0.90, vLineAlong);
    float baseLift = 0.54 + exp(-vLineAlong * 9.0) * 0.40;
    float alpha = baseLift * topFade * mix(1.0, 0.78, vLineTier);
    gl_FragColor = vec4(uWaterColor, alpha);
    #include <colorspace_fragment>
  }
`

const glintVertexShader = /* glsl */`
  attribute float aGlintSize;
  attribute float aGlintAlpha;
  uniform float uPixelRatio;
  varying float vGlintAlpha;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aGlintSize * uPixelRatio;
    vGlintAlpha = aGlintAlpha;
  }
`

const glintFragmentShader = /* glsl */`
  uniform vec3 uGlintColor;
  varying float vGlintAlpha;
  void main() {
    float radial = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = (1.0 - smoothstep(0.08, 1.0, radial)) * vGlintAlpha;
    if (alpha < 0.008) discard;
    gl_FragColor = vec4(uGlintColor, alpha);
    #include <colorspace_fragment>
  }
`

export const createFountainSystem = ({ onNozzlePulse } = {}) => {
  const cfg = POOL_3D_CONFIG.fountain
  const nozzles = createNozzleLayout(cfg)
  const linePositions = new Float32Array(nozzles.length * 6)
  const lineAlong = new Float32Array(nozzles.length * 2)
  const lineTier = new Float32Array(nozzles.length * 2)
  for (let index = 0; index < nozzles.length; index++) {
    const nozzle = nozzles[index]
    linePositions[index * 6] = nozzle.x
    linePositions[index * 6 + 1] = 0.045
    linePositions[index * 6 + 2] = nozzle.z
    linePositions[index * 6 + 3] = nozzle.x
    linePositions[index * 6 + 4] = nozzle.height * 0.86
    linePositions[index * 6 + 5] = nozzle.z
    lineAlong[index * 2] = 0
    lineAlong[index * 2 + 1] = 1
    lineTier[index * 2] = nozzle.tier
    lineTier[index * 2 + 1] = nozzle.tier
  }
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3))
  lineGeometry.setAttribute('aLineAlong', new THREE.BufferAttribute(lineAlong, 1))
  lineGeometry.setAttribute('aTier', new THREE.BufferAttribute(lineTier, 1))
  const lineMaterial = new THREE.ShaderMaterial({
    uniforms: { uWaterColor: { value: new THREE.Color(0xc8dce6) } },
    vertexShader: streamVertexShader,
    fragmentShader: streamFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: false,
  })
  const streams = new THREE.LineSegments(lineGeometry, lineMaterial)
  streams.name = 'ContinuousVerticalFountainStreams'
  streams.frustumCulled = false
  streams.renderOrder = 4

  // Intentionally sparse: these are local reflected pools at selected nozzle
  // bases, never two continuous luminous tracks.
  const glintNozzles = nozzles.filter(nozzle =>
    (nozzle.tier === 0 && nozzle.index % 3 === 0)
    || (nozzle.tier === 1 && nozzle.index % 4 === 1))
  const glintPositions = new Float32Array(glintNozzles.length * 3)
  const glintSizes = new Float32Array(glintNozzles.length)
  const glintAlpha = new Float32Array(glintNozzles.length)
  glintNozzles.forEach((nozzle, index) => {
    glintPositions[index * 3] = nozzle.x
    glintPositions[index * 3 + 1] = 0.052
    glintPositions[index * 3 + 2] = nozzle.z
    glintSizes[index] = nozzle.tier === 0 ? 25 : 19
    glintAlpha[index] = 0.22 + hash01(index * 2.81) * 0.16
  })
  const glintGeometry = new THREE.BufferGeometry()
  glintGeometry.setAttribute('position', new THREE.BufferAttribute(glintPositions, 3))
  glintGeometry.setAttribute('aGlintSize', new THREE.BufferAttribute(glintSizes, 1))
  glintGeometry.setAttribute('aGlintAlpha', new THREE.BufferAttribute(glintAlpha, 1))
  const glintMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: 1 },
      uGlintColor: { value: new THREE.Color(0x9bc7d9) },
    },
    vertexShader: glintVertexShader,
    fragmentShader: glintFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: false,
  })
  const baseGlints = new THREE.Points(glintGeometry, glintMaterial)
  baseGlints.name = 'SparseNozzleBaseReflections'
  baseGlints.frustumCulled = false
  baseGlints.renderOrder = 3
  const count = nozzles.reduce((sum, nozzle) => sum
    + (nozzle.tier === 0 ? cfg.innerParticlesPerJet : cfg.activeParticlesPerJet), 0)
  const base = new Float32Array(count * 2)
  const along = new Float32Array(count)
  const height = new Float32Array(count)
  const phase = new Float32Array(count)
  const tier = new Float32Array(count)
  const seed = new Float32Array(count)
  let cursor = 0
  for (const nozzle of nozzles) {
    const perJet = nozzle.tier === 0 ? cfg.innerParticlesPerJet : cfg.activeParticlesPerJet
    for (let i = 0; i < perJet; i++, cursor++) {
      base[cursor * 2] = nozzle.x
      base[cursor * 2 + 1] = nozzle.z
      along[cursor] = hash01(i * 19.37 + nozzle.index * 7.11 + nozzle.tier * 103)
      height[cursor] = nozzle.height
      phase[cursor] = nozzle.phase
      tier[cursor] = nozzle.tier
      seed[cursor] = hash01(cursor * 0.73 + nozzle.index * 5.3)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('aBase', new THREE.BufferAttribute(base, 2))
  geometry.setAttribute('aAlong', new THREE.BufferAttribute(along, 1))
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(height, 1))
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
  geometry.setAttribute('aTier', new THREE.BufferAttribute(tier, 1))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uMotion: { value: cfg.streamSpeed },
    uWaterColor: { value: new THREE.Color(0xc8dce6) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: false,
  })
  const points = new THREE.Points(geometry, material)
  points.name = 'TwoRingVerticalMemoryFountain'
  points.frustumCulled = false
  points.renderOrder = 5
  const group = new THREE.Group()
  group.name = 'IndependentFountainApparatus'
  group.add(baseGlints, streams, points)

  let frozenSeconds = 0
  let wasReduced = false
  const pulseCycles = new Int32Array(nozzles.length).fill(-2147483648)
  return {
    group,
    nozzles,
    update(seconds, reducedMotion = false) {
      if (reducedMotion) {
        if (!wasReduced) frozenSeconds = uniforms.uTime.value
        uniforms.uTime.value = frozenSeconds
      } else uniforms.uTime.value = seconds
      wasReduced = reducedMotion
      if (!reducedMotion && onNozzlePulse) {
        for (let index = 0; index < nozzles.length; index++) {
          const nozzle = nozzles[index]
          const period = nozzle.tier === 0 ? 0.76 : 0.92
          const cycle = Math.floor((seconds + nozzle.phase * period) / period)
          if (pulseCycles[index] === -2147483648) {
            pulseCycles[index] = cycle
            continue
          }
          if (cycle <= pulseCycles[index]) continue
          pulseCycles[index] = cycle
          const jitterAngle = hash01(cycle * 1.71 + index * 3.9) * TAU
          const jitterRadius = 0.012 + hash01(cycle * 7.3 + index) * 0.016
          onNozzlePulse({
            x: nozzle.x + Math.cos(jitterAngle) * jitterRadius,
            z: nozzle.z + Math.sin(jitterAngle) * jitterRadius,
            strength: nozzle.tier === 0 ? 0.58 : 0.34,
            tier: nozzle.tier,
          })
        }
      }
    },
    resize(pixelRatio = 1) {
      const value = Math.max(1, Number(pixelRatio) || 1)
      uniforms.uPixelRatio.value = value
      glintMaterial.uniforms.uPixelRatio.value = value
    },
    metrics() {
      return {
        drawCalls: 3,
        particleCount: count,
        innerNozzles: cfg.innerNozzles,
        activeNozzles: cfg.activeNozzles,
        outerNozzles: 0,
      }
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      lineGeometry.dispose()
      lineMaterial.dispose()
      glintGeometry.dispose()
      glintMaterial.dispose()
      group.clear()
    },
  }
}
