// Tier 1 3D tide-pool constants. Keep every atmosphere knob here so the data
// mapping stays visually inspectable and does not get scattered through shaders.
export const POOL_3D_CONFIG = Object.freeze({
  worldRadius: 5,
  waterRadiusScale: 2.15,
  waterSegments: 160,
  waterRadialSegments: 56,
  pixelRatioMax: 1.5,
  fogDensity: 0.018,
  camera: Object.freeze({
    fov: 35,
    near: 0.08,
    far: 42,
    position: Object.freeze([0, 5.4, 16.8]),
    target: Object.freeze([0, 1.45, 0]),
    minDistance: 9,
    maxDistance: 22,
    minPolarAngle: 0.62,
    maxPolarAngle: 1.42,
    minAzimuthAngle: -0.88,
    maxAzimuthAngle: 0.88,
    dampingFactor: 0.08,
    rotateSpeed: 0.55,
    zoomSpeed: 0.8,
    dragThresholdPx: 5,
    resetMs: 680,
    idleBeforeDriftMs: 9000,
    autoRotateSpeed: 0.08,
  }),
  water: Object.freeze({
    heightFieldResolution: 512,
    maxImpulsesPerFrame: 32,
    simulationStep: 1 / 90,
    waveCoefficient: 950,
    damping: 2.4,
    boundaryAbsorption: 7.5,
    impulseRadius: 0.012,
    ambientImpact: 0.11,
    semanticImpact: 0.22,
    heightScale: 0.11,
    normalStrength: 2.1,
    tideMarkSlots: 12,
    edgeFadeStart: 0.84,
  }),
  rain: Object.freeze({
    seed: 0x71de4a2b,
    maxMemoryStrands: 256,
    maxEventStrands: 24,
    maxQueuedStrands: 256,
    maxSegments: 32,
    minSegments: 16,
    minHeight: 5.8,
    maxHeight: 10.8,
    minFallMs: 820,
    maxFallMs: 1280,
    minMemoryFallMs: 1800,
    maxMemoryFallMs: 3200,
    rememberFallMs: 380,
    trailLength: 4.6,
    maxDrift: 0.05,
    dropBloom: 1,
    impactBloom: 1,
    crownLifetime: 0.28,
    crownBloom: 0.88,
    impactSlots: 32,
    impactLifetime: 0.36,
    recentPickMs: 3200,
    maxVisibleFrameGap: 0.12,
  }),
  tideMark: Object.freeze({
    stayMs: 4500,
    fadeMs: 800,
  }),
  palette: Object.freeze({
    abyss: 0x02060a,
    deepBlue: 0x102838,
    steel: 0x8fa5b3,
    pearl: 0xe7f5fa,
    coldGlint: 0xb9cfda,
  }),
})

export const cappedPixelRatio = (devicePixelRatio = 1, max = POOL_3D_CONFIG.pixelRatioMax) =>
  Math.max(1, Math.min(Number(devicePixelRatio) || 1, max))

// Preserve at least the desktop vertical field of view on the narrow axis.
// Portrait screens therefore widen the vertical FOV instead of cropping the
// truthful radial layout. The cap avoids fisheye distortion on extreme embeds.
export const fittedVerticalFov = (aspect, baseFov = POOL_3D_CONFIG.camera.fov) => {
  const safeAspect = Math.max(0.2, Number(aspect) || 1)
  if (safeAspect >= 1) return baseFov
  const half = baseFov * Math.PI / 360
  return Math.min(78, Math.atan(Math.tan(half) / safeAspect) * 360 / Math.PI)
}

// The only spatial data mapping: normalized polar radius -> XZ disk radius.
// Y is a fixed decorative lift, never a second data channel.
export const polarToWorld = (particle, radius = POOL_3D_CONFIG.worldRadius) => ({
  x: Number(particle.pr ?? particle.r) * radius * Math.cos(Number(particle.theta)),
  y: 0.055,
  z: Number(particle.pr ?? particle.r) * radius * Math.sin(Number(particle.theta)),
})

export const wantsThreePreview = (search = '') =>
  new URLSearchParams(search).get('renderer') === '3d'
