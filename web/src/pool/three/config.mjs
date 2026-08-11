// Tier 1 3D tide-pool constants. Keep every atmosphere knob here so the data
// mapping stays visually inspectable and does not get scattered through shaders.
export const POOL_3D_CONFIG = Object.freeze({
  worldRadius: 5,
  waterRadiusScale: 3.4,
  waterSegments: 240,
  waterRadialSegments: 120,
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
    damping: 2.15,
    boundaryAbsorption: 7.5,
    impulseRadius: 0.0052,
    ambientImpact: 0.061,
    semanticImpact: 0.121,
    baseAlpha: 0.08,
    underwaterY: -0.18,
    underwaterPointTransmission: 1,
    tideMarkSlots: 12,
    edgeFadeStart: 0.46,
  }),
  rain: Object.freeze({
    seed: 0x71de4a2b,
    maxMemoryStrands: 256,
    trailsPerMemory: 6,
    maxEventStrands: 24,
    maxQueuedStrands: 256,
    minHeight: 8.5,
    maxHeight: 12.5,
    minFallMs: 700,
    maxFallMs: 950,
    minMemoryFallMs: 700,
    maxMemoryFallMs: 1050,
    rememberFallMs: 760,
    minStreakLength: 0.075,
    maxStreakLength: 0.18,
    minStreakWidthRatio: 0.055,
    maxStreakWidthRatio: 0.11,
    maxTrackOffset: 0.22,
    maxDrift: 0.01,
    dropBloom: 0.66,
    impactBloom: 0.82,
    impactSlots: 24,
    impactLifetime: 0.14,
    rippleLifetime: 0.72,
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
