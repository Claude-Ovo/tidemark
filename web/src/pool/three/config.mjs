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
    fov: 34,
    near: 0.08,
    far: 42,
    position: Object.freeze([0, 10.5, 12.5]),
    target: Object.freeze([0, 0, 0]),
    minDistance: 8.6,
    maxDistance: 20,
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
    impactLifetime: 7.2,
    ambientAmplitude: 0.008,
    impactAmplitude: 0.12,
    waveSpeed: 0.72,
    waveNumber: 6.4,
    edgeFadeStart: 0.84,
  }),
  rain: Object.freeze({
    seed: 0x71de4a2b,
    count: 58,
    reducedCount: 8,
    minHeight: 3.8,
    maxHeight: 12.5,
    minSpeed: 1.05,
    maxSpeed: 1.8,
    radiusScale: 0.91,
    rememberStartHeight: 3.1,
  }),
  tideMark: Object.freeze({
    stayMs: 4500,
    fadeMs: 800,
  }),
  palette: Object.freeze({
    abyss: 0x05080d,
    deepBlue: 0x081724,
    steel: 0x6f879b,
    pearl: 0xdceaf3,
    coldGlint: 0xa9c9dc,
  }),
})

export const cappedPixelRatio = (devicePixelRatio = 1, max = POOL_3D_CONFIG.pixelRatioMax) =>
  Math.max(1, Math.min(Number(devicePixelRatio) || 1, max))

// The only spatial data mapping: normalized polar radius -> XZ disk radius.
// Y is a fixed decorative lift, never a second data channel.
export const polarToWorld = (particle, radius = POOL_3D_CONFIG.worldRadius) => ({
  x: Number(particle.pr ?? particle.r) * radius * Math.cos(Number(particle.theta)),
  y: 0.055,
  z: Number(particle.pr ?? particle.r) * radius * Math.sin(Number(particle.theta)),
})

export const wantsThreePreview = (search = '') =>
  new URLSearchParams(search).get('renderer') === '3d'
