import assert from 'node:assert/strict'
import { POOL_3D_CONFIG, cappedPixelRatio, polarToWorld, wantsThreePreview } from './src/pool/three/config.mjs'
import { seededUnitDiskSamples } from './src/pool/three/rain-system.mjs'
import { createRadialDiskGeometry } from './src/pool/three/water-disk.mjs'

assert.equal(wantsThreePreview('?renderer=3d'), true)
assert.equal(wantsThreePreview('?renderer=2d'), false)
assert.equal(wantsThreePreview('?script=1'), false, '3D remains opt-in until visual gate')

assert.equal(cappedPixelRatio(3), POOL_3D_CONFIG.pixelRatioMax)
assert.equal(cappedPixelRatio(0), 1)

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
assert.ok(POOL_3D_CONFIG.water.impactLifetime >= 6, 'impact waves need time to visibly spread')

const rainA = seededUnitDiskSamples(512, 42)
const rainB = seededUnitDiskSamples(512, 42)
assert.deepEqual(rainA, rainB, 'rain layout must be stable for a fixed seed')
assert.ok(rainA.every(({ x, z }) => Math.hypot(x, z) <= 1 + 1e-12), 'rain must land inside the water disk')
const meanRadiusSquared = rainA.reduce((sum, { x, z }) => sum + x * x + z * z, 0) / rainA.length
assert.ok(Math.abs(meanRadiusSquared - 0.5) < 0.06, 'rain must sample disk area uniformly, not bunch at the centre')

const waterGeometry = createRadialDiskGeometry(5, 8, 24)
assert.equal(waterGeometry.attributes.position.count, 1 + 8 * 24)
assert.equal(waterGeometry.index.count, 24 * 3 + 7 * 24 * 6)
assert.ok(waterGeometry.attributes.position.count > 24, 'water needs interior vertices for local ripple displacement')
waterGeometry.dispose()

console.log('ok - 3D pool Tier 1 config, polar mapping, edge fade, and seeded rain')
