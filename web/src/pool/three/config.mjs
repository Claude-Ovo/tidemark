// Tier 1 3D tide-pool constants. Keep every atmosphere knob here so the data
// mapping stays visually inspectable and does not get scattered through shaders.
export const POOL_3D_CONFIG = Object.freeze({
  worldRadius: 5,
  waterRadiusScale: 1.18,
  waterSegments: 160,
  waterRadialSegments: 56,
  pixelRatioMax: 1.5,
  fogDensity: 0.045,
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
    impactSlots: 58,
    ambientImpactSlots: 48,
    semanticImpactSlots: 10,
    ambientImpactLifetime: 0.95,
    semanticImpactLifetime: 7.2,
    ambientAmplitude: 0.005,
    impactAmplitude: 0.14,
    waveSpeed: 0.65,
    waveNumber: 7.0,
    dimpleDuration: 0.22,
    edgeFadeStart: 0.84,
  }),
  rain: Object.freeze({
    seed: 0x71de4a2b,
    count: 48,
    reducedCount: 8,
    sigma: 0.38,
    maxRadius: 0.78,
    centerDensity: 1,
    edgeDensity: 0.02,
    minHeight: 2,
    maxHeight: 6,
    respawnJitter: 0.8,
    minSpeed: 3.5,
    maxSpeed: 5,
    minLength: 0.18,
    maxLength: 0.30,
    centerOpacity: 0.9,
    edgeOpacity: 0.24,
    centerImpact: 0.48,
    edgeImpact: 0.18,
    dropBloom: 1,
    impactBloom: 0.72,
    splashSlots: 48,
    splashLifetime: 0.36,
    rememberStartHeight: 3.1,
  }),
  tideMark: Object.freeze({
    stayMs: 4500,
    fadeMs: 800,
  }),
  palette: Object.freeze({
    abyss: 0x081018,
    deepBlue: 0x123140,
    steel: 0x9fafb9,
    pearl: 0xeaf5f8,
    coldGlint: 0xbdd8e4,
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
