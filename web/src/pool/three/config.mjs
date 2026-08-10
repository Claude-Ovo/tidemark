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
    impactSlots: 24,
    ambientImpactSlots: 14,
    semanticImpactSlots: 10,
    impactLifetime: 7.2,
    ambientAmplitude: 0.012,
    impactAmplitude: 0.16,
    waveSpeed: 0.72,
    waveNumber: 6.4,
    edgeFadeStart: 0.84,
  }),
  rain: Object.freeze({
    seed: 0x71de4a2b,
    count: 360,
    reducedCount: 16,
    minHeight: 4.2,
    maxHeight: 13.5,
    minSpeed: 4.2,
    maxSpeed: 6.8,
    radiusScale: 0.94,
    waterImpactStride: 24,
    splashSlots: 96,
    splashLifetime: 0.48,
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
