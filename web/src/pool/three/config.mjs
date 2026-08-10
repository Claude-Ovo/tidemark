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
  // 2026-08-11 Claude 参数手术（Owner "照抄参考图" 终裁）：参考图的可读性来自
  // 【少而清】——每秒 ~6-7 滴、每滴一个张得开(≥2u)、活得久(1.9s)的细亮环，
  // 圈与圈能被单独看见；此前 96 滴 ×0.88s×0.46u/s = 永远张不开的环挤成光浆（粘液感主凶）。
  // 位移近零：水读起来像镜面靠"黑底+亮线"，不靠顶点鼓包。
  water: Object.freeze({
    impactSlots: 28,
    ambientImpactSlots: 18,       // === rain.count（判别不变量：每滴在场雨有专属槽）
    semanticImpactSlots: 10,
    ambientImpactLifetime: 1.9,
    semanticImpactLifetime: 6.0,  // ×waveSpeed 1.15 = 6.9u 行程，覆盖全盘后淡出
    ambientAmplitude: 0.0008,
    impactAmplitude: 0.13,
    waveSpeed: 1.15,
    waveNumber: 7.2,
    ringWidth: 0.016,
    ringIntensity: 0.62,
    secondaryRingIntensity: 0.24,
    ambientDisplacement: 0.0,
    semanticDisplacement: 0.05,
    dimpleDuration: 0.16,
    dimpleDisplacement: 0.08,
    edgeFadeStart: 0.84,
  }),
  rain: Object.freeze({
    seed: 0x71de4a2b,
    count: 18,
    reducedCount: 6,
    sigma: 0.27,
    maxRadius: 0.58,
    centerDensity: 1,
    edgeDensity: 0.006,
    minHeight: 3.5,
    maxHeight: 10,               // (10-0.06)/maxSpeed=1.99 > 环寿命 1.9（判别：一滴不得在自己旧环未灭时二次落地）
    respawnJitter: 1.6,
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
    splashSlots: 32,
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
