import assert from 'node:assert/strict'
import { POOL_3D_CONFIG, cappedPixelRatio, fittedVerticalFov, polarToWorld, wantsThreePreview } from './src/pool/three/config.mjs'
import { advanceRainDrop, seededGaussianDiskSamples, seededUnitDiskSamples } from './src/pool/three/rain-system.mjs'
import { createImpactSlotAllocator, createRadialDiskGeometry } from './src/pool/three/water-disk.mjs'

assert.equal(wantsThreePreview('?renderer=3d'), true)
assert.equal(wantsThreePreview('?renderer=2d'), false)
assert.equal(wantsThreePreview('?script=1'), false, '3D remains opt-in until visual gate')

assert.equal(cappedPixelRatio(3), POOL_3D_CONFIG.pixelRatioMax)
assert.equal(cappedPixelRatio(0), 1)
assert.equal(fittedVerticalFov(16 / 9), POOL_3D_CONFIG.camera.fov)
assert.ok(fittedVerticalFov(9 / 16) > POOL_3D_CONFIG.camera.fov,
  'portrait framing must widen vertical FOV instead of cropping the pool')
assert.ok(fittedVerticalFov(0.01) <= 78, 'extreme portrait embeds must avoid fisheye FOV')

const center = polarToWorld({ pr: 0, theta: 1.7 })
assert.ok(Math.abs(center.x) === 0)
assert.ok(Math.abs(center.z) === 0)
const edge = polarToWorld({ pr: 0.5, theta: Math.PI / 2 })
assert.ok(Math.abs(edge.x) < 1e-12)
assert.ok(Math.abs(edge.z - POOL_3D_CONFIG.worldRadius * 0.5) < 1e-12)

const inner = polarToWorld({ pr: 0.2, theta: 0 })
const outer = polarToWorld({ pr: 0.8, theta: 0 })
assert.ok(Math.hypot(inner.x, inner.z) < Math.hypot(outer.x, outer.z), '3D mapping must preserve radial truth')
assert.equal(inner.y, outer.y, 'Y must not encode retention')

const camera = POOL_3D_CONFIG.camera
assert.ok(camera.maxPolarAngle < Math.PI / 2, 'camera may not travel below water')
assert.equal(camera.minAzimuthAngle, -camera.maxAzimuthAngle, 'initial azimuth clamp stays symmetric')
assert.equal(camera.dragThresholdPx, 5)

assert.ok(POOL_3D_CONFIG.water.edgeFadeStart >= 0.8 && POOL_3D_CONFIG.water.edgeFadeStart <= 0.9,
  'water must fade through roughly the outer 10-20%, not end as a hard disk')
assert.ok(POOL_3D_CONFIG.water.waveNumber < 10, 'impact waves must stay broad enough to read')
assert.ok(POOL_3D_CONFIG.water.semanticImpactLifetime >= 6, 'semantic waves need time to visibly spread')
assert.ok(POOL_3D_CONFIG.water.ambientImpactLifetime < POOL_3D_CONFIG.water.semanticImpactLifetime,
  'rain ripples must be brief while semantic waves remain legible')
assert.ok(POOL_3D_CONFIG.water.ringWidth > 0 && POOL_3D_CONFIG.water.ringWidth <= 0.02,
  'rain impacts must render as fine lines rather than raised circular bands')
  // 2026-08-11 上界 0.012→0.02：参考图定稿的环线略粗于最初估计（0.016），仍是细线量级（<0.4% 盘径）
assert.ok(POOL_3D_CONFIG.water.ambientDisplacement < POOL_3D_CONFIG.water.semanticDisplacement,
  'ambient rain may not deform the mirror as strongly as semantic feedback')
assert.equal(POOL_3D_CONFIG.water.ambientImpactSlots + POOL_3D_CONFIG.water.semanticImpactSlots,
  POOL_3D_CONFIG.water.impactSlots, 'impact partitions must fill the shader buffer')
const ambientSlots = POOL_3D_CONFIG.water.ambientImpactSlots
const semanticSlots = POOL_3D_CONFIG.water.semanticImpactSlots
const slots = createImpactSlotAllocator({ ambientSlots, semanticSlots })
const semanticSlot = slots.next('semantic')
const ambientWrites = Array.from({ length: 360 }, () => slots.next('ambient'))
assert.ok(ambientWrites.every(slot => slot < ambientSlots), 'ambient rain must stay inside its slot partition')
assert.ok(semanticSlot >= ambientSlots && semanticSlot < ambientSlots + semanticSlots,
  'semantic impact must use the protected partition')
assert.ok(!ambientWrites.includes(semanticSlot), 'ambient rain may not evict a semantic wave')
assert.throws(() => slots.next('unknown'), /unknown impact kind/)

const rainA = seededUnitDiskSamples(512, 42)
const rainB = seededUnitDiskSamples(512, 42)
assert.deepEqual(rainA, rainB, 'rain layout must be stable for a fixed seed')
assert.ok(rainA.every(({ x, z }) => Math.hypot(x, z) <= 1 + 1e-12), 'rain must land inside the water disk')
const meanRadiusSquared = rainA.reduce((sum, { x, z }) => sum + x * x + z * z, 0) / rainA.length
assert.ok(Math.abs(meanRadiusSquared - 0.5) < 0.06, 'rain must sample disk area uniformly, not bunch at the centre')

const gaussianA = seededGaussianDiskSamples(1024, { seed: 42 })
const gaussianB = seededGaussianDiskSamples(1024, { seed: 42 })
assert.deepEqual(gaussianA, gaussianB, 'central rain field must be deterministic for a fixed seed')
assert.ok(gaussianA.every(({ x, z }) => Math.hypot(x, z) <= POOL_3D_CONFIG.rain.maxRadius + 1e-12),
  'central rain must stay inside its soft maximum radius')
const gaussianMeanR2 = gaussianA.reduce((sum, { x, z }) => sum + x * x + z * z, 0) / gaussianA.length
assert.ok(gaussianMeanR2 < meanRadiusSquared * 0.45, 'rain density must concentrate smoothly near the centre')
assert.equal(POOL_3D_CONFIG.water.ambientImpactSlots, POOL_3D_CONFIG.rain.count,
  'every simultaneously visible ambient drop must have a dedicated impact slot')
assert.ok(POOL_3D_CONFIG.water.ambientImpactLifetime
    < (POOL_3D_CONFIG.rain.maxHeight - 0.06) / POOL_3D_CONFIG.rain.maxSpeed,
  'a drop may not land twice before its previous ambient ripple expires')
assert.deepEqual(advanceRainDrop(0.07, 1, 0.02), { height: 0.06, landed: true },
  'a drop must clamp exactly to the water plane when its impact fires')
assert.deepEqual(advanceRainDrop(0.5, 1, 0.02), { height: 0.48, landed: false },
  'a drop above the water may not trigger an early ripple')

const waterGeometry = createRadialDiskGeometry(5, 8, 24)
assert.equal(waterGeometry.attributes.position.count, 1 + 8 * 24)
assert.equal(waterGeometry.index.count, 24 * 3 + 7 * 24 * 6)
assert.ok(waterGeometry.attributes.position.count > 24, 'water needs interior vertices for local ripple displacement')
waterGeometry.dispose()

console.log('ok - 3D pool Tier 1 config, polar mapping, edge fade, and seeded rain')
