import assert from 'node:assert/strict'
import { POOL_3D_CONFIG, cappedPixelRatio, polarToWorld, wantsThreePreview } from './src/pool/three/config.mjs'

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

console.log('ok - 3D pool Tier 1 config and polar mapping')
