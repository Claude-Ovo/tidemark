// Tier 1 3D tide-pool constants. Keep every atmosphere knob here so the data
// mapping stays visually inspectable and does not get scattered through shaders.
export const POOL_3D_CONFIG = Object.freeze({
  worldRadius: 5,
  waterRadiusScale: 3.4,
  waterSegments: 240,
  waterRadialSegments: 120,
  pixelRatioMax: 1.5,
  fogDensity: 0.018,
  maxMemoryPoints: 256,
  camera: Object.freeze({
    fov: 35,
    near: 0.08,
    far: 42,
    position: Object.freeze([7.8, 6.2, 14.6]),
    target: Object.freeze([0, 1.65, 0]),
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
    baseAlpha: 0.22,
    underwaterY: -0.18,
    underwaterPointTransmission: 1,
    tideMarkSlots: 12,
    edgeFadeStart: 0.70,
  }),
  fountain: Object.freeze({
    innerNozzles: 24,
    activeNozzles: 38,
    innerRadius: 1.08,
    activeRadius: 2.38,
    innerHeight: 5.2,
    activeHeightRatio: 0.61,
    innerParticlesPerJet: 22,
    activeParticlesPerJet: 16,
    heightVariation: 0.075,
    streamSpeed: 0.29,
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
