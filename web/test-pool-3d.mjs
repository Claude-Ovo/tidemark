import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { POOL_3D_CONFIG, cappedPixelRatio, fittedVerticalFov, polarToWorld, wantsThreePreview } from './src/pool/three/config.mjs'
import { mergeHeightFieldImpulses, worldToFieldUv } from './src/pool/three/height-field.mjs'
import {
  advanceStrandLifecycle,
  buildMemoryStrandSpec,
  buildStrandSpec,
  crossingCount,
  stableEventHash,
} from './src/pool/three/rain-system.mjs'
import { selectShaderTideMarks } from './src/pool/three/tide-mark-group.mjs'
import { createRadialDiskGeometry } from './src/pool/three/water-disk.mjs'

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
assert.equal(camera.fov, 35, 'Owner low-angle framing uses the specified ~35 degree FOV')

assert.ok(POOL_3D_CONFIG.water.heightFieldResolution >= 512
  && POOL_3D_CONFIG.water.heightFieldResolution <= 768, 'height field must stay in the accepted desktop range')
assert.ok(POOL_3D_CONFIG.water.edgeFadeStart >= 0.8 && POOL_3D_CONFIG.water.edgeFadeStart <= 0.9,
  'water must disappear into darkness instead of exposing a hard disk edge')
assert.ok(POOL_3D_CONFIG.rain.minSegments >= 16 && POOL_3D_CONFIG.rain.maxSegments <= 32,
  'one memory strand must contain 16-32 visual beads')
assert.ok(POOL_3D_CONFIG.water.waveCoefficient * POOL_3D_CONFIG.water.simulationStep ** 2 < 0.5,
  'height-field wave coefficient must stay inside the explicit integrator stability budget')

const event = { kind: 'recall', event_id: 'req-123', memory_ids: ['memory-1'] }
const strandA = buildStrandSpec(event, { x: 1.2, z: -0.4 })
const strandB = buildStrandSpec(event, { x: 1.2, z: -0.4 })
assert.deepEqual(strandA, strandB, 'one committed event must always produce the same strand grammar')
assert.equal(strandA.key, 'recall|req-123')
assert.ok(strandA.segments >= 16 && strandA.segments <= 32)
assert.equal(stableEventHash('recall|req-123'), stableEventHash('recall|req-123'))
assert.deepEqual(advanceStrandLifecycle({ born: 1, duration: 0.5, landed: false }, 1.49),
  { progress: 0.98, landed: false, landsNow: false })
assert.deepEqual(advanceStrandLifecycle({ born: 1, duration: 0.5, landed: false }, 1.5),
  { progress: 1, landed: true, landsNow: true })
assert.deepEqual(advanceStrandLifecycle({ born: 1, duration: 0.5, landed: true }, 1.8),
  { progress: 1, landed: true, landsNow: false }, 'a strand may inject exactly one water impact')

const particle = { memory_id: 'memory-123', pr: 0.42, theta: 1.25, s: 0.8 }
const memoryStrandA = buildMemoryStrandSpec(particle)
const memoryStrandB = buildMemoryStrandSpec(particle)
const memoryLanding = polarToWorld(particle)
assert.deepEqual(memoryStrandA, memoryStrandB, 'memory strands must be deterministic across renders')
assert.equal(memoryStrandA.source, 'memory')
assert.equal(memoryStrandA.x, memoryLanding.x, 'strand and interaction anchor must share landing X')
assert.equal(memoryStrandA.z, memoryLanding.z, 'strand and interaction anchor must share landing Z')
assert.ok(memoryStrandA.segments >= 16 && memoryStrandA.segments <= 32)
assert.ok(memoryStrandA.duration >= POOL_3D_CONFIG.rain.minMemoryFallMs / 1000)
assert.ok(memoryStrandA.duration <= POOL_3D_CONFIG.rain.maxMemoryFallMs / 1000)
assert.equal(crossingCount(1, 1.1, 1.05, 2.4), 1, 'one visible landing must count once')
assert.equal(crossingCount(1, 8.4, 1.05, 2.4), 4, 'missed loops must advance deterministically')

const uvCenter = worldToFieldUv(0, 0, 5)
assert.deepEqual(uvCenter, { u: 0.5, v: 0.5 })
assert.deepEqual(worldToFieldUv(5, -5, 5), { u: 1, v: 0 })
const merged = mergeHeightFieldImpulses([
  { u: 0.5001, v: 0.5001, strength: 0.2, radius: 0.01 },
  { u: 0.5002, v: 0.5002, strength: 0.3, radius: 0.02 },
  { u: 0.8, v: 0.8, strength: 0.4, radius: 0.01 },
], 512)
assert.equal(merged.length, 2, 'same-texel impacts merge instead of being randomly discarded')
assert.equal(merged.reduce((sum, impulse) => sum + impulse.eventCount, 0), 3,
  'merged GPU writes must retain the exact committed event count')
assert.equal(merged.find(impulse => impulse.eventCount === 2).strength, 0.5)

const marks = selectShaderTideMarks([
  { p: { memory_id: 'a', pr: 0.2, theta: 0 }, kind: 'credited', t0: 1000 },
  { p: { memory_id: 'b', pr: 0.4, theta: Math.PI }, kind: 'blamed', t0: 2000 },
], 2)
assert.deepEqual(marks.map(mark => mark.polarity), [-1, 1])
assert.deepEqual(marks.map(mark => mark.memory_id), ['b', 'a'])

const waterGeometry = createRadialDiskGeometry(5, 8, 24)
assert.equal(waterGeometry.attributes.position.count, 1 + 8 * 24)
assert.equal(waterGeometry.index.count, 24 * 3 + 7 * 24 * 6)
waterGeometry.dispose()

for (const file of [
  './src/pool/three/water-disk.mjs',
  './src/pool/three/data-model-group.mjs',
  './src/pool/three/tide-mark-group.mjs',
]) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /RingGeometry|LineLoop|lineRing\s*\(/,
    `${file} may not reintroduce independent geometric or fragment rings`)
}

const anchorSource = readFileSync(new URL('./src/pool/three/data-model-group.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(anchorSource, /Sprite|CanvasTexture|SpriteMaterial/,
  'memory records must not reappear as a flat point layer on the water')
const rainSource = readFileSync(new URL('./src/pool/three/rain-system.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(rainSource, /new THREE\.Mesh/,
  'rain and contact feedback must use shared point pools rather than per-drop mesh churn')

console.log('ok - 3D pool maps persisted memories to pooled rain strands and a ring-free HalfFloat height field')
