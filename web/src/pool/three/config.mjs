// Tier 1 3D tide-pool constants. Keep every atmosphere knob here so the data
// mapping stays visually inspectable and does not get scattered through shaders.
export const POOL_3D_CONFIG = Object.freeze({
  worldRadius: 5,
  waterRadiusScale: 1.18,
  waterSegments: 160,
  waterRadialSegments: 56,
  pixelRatioMax: 1.5,
  fogDensity: 0.018,
  camera: Object.freeze({
    fov: 36,
    near: 0.08,
    far: 42,
    position: Object.freeze([0, 11.8, 14.2]),
    target: Object.freeze([0, 0, 0]),
    minDistance: 9,
    maxDistance: 22,
    minPolarAngle: 0.34,
    maxPolarAngle: 1.34,
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
    impactSlots: 106,
    ambientImpactSlots: 96,
    semanticImpactSlots: 10,
    ambientImpactLifetime: 0.88,
    semanticImpactLifetime: 7.2,
    ambientAmplitude: 0.0018,
    impactAmplitude: 0.13,
    waveSpeed: 0.46,
    waveNumber: 7.2,
    ringWidth: 0.010,
    ringIntensity: 0.62,
    secondaryRingIntensity: 0.24,
    ambientDisplacement: 0.025,
    semanticDisplacement: 0.15,
    dimpleDuration: 0.16,
    dimpleDisplacement: 0.22,
    edgeFadeStart: 0.84,
  }),
  rain: Object.freeze({
    seed: 0x71de4a2b,
    count: 96,
    reducedCount: 12,
    sigma: 0.27,
    maxRadius: 0.58,
    centerDensity: 1,
    edgeDensity: 0.006,
    minHeight: 2,
    maxHeight: 6,
    respawnJitter: 0.8,
    minSpeed: 3.5,
    maxSpeed: 5,
    minLength: 0.27,
    maxLength: 0.42,
    centerOpacity: 1,
    edgeOpacity: 0.30,
    centerImpact: 0.48,
    edgeImpact: 0.18,
    dropBloom: 1.14,
    impactBloom: 1,
    crownLifetime: 0.055,
    crownBloom: 1,
    splashSlots: 96,
    splashLifetime: 0.22,
    rememberStartHeight: 3.1,
  }),
  tideMark: Object.freeze({
    stayMs: 4500,
    fadeMs: 800,
  }),
  palette: Object.freeze({
    abyss: 0x02060a,
    deepBlue: 0x07121c,
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
