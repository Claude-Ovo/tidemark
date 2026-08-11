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
assert.ok(POOL_3D_CONFIG.water.edgeFadeStart >= 0.4 && POOL_3D_CONFIG.water.edgeFadeStart <= 0.55,
  'the oversized water base needs a broad feather instead of a hard disk edge')
assert.ok(POOL_3D_CONFIG.water.baseAlpha >= 0.06 && POOL_3D_CONFIG.water.baseAlpha <= 0.12,
  'submission water must remain a nearly invisible transparent base')
assert.ok(POOL_3D_CONFIG.waterRadiusScale >= 3,
  'water geometry must extend beyond the normal camera framing')
assert.equal(POOL_3D_CONFIG.rain.trailsPerMemory, 6,
  'six deterministic tracks are the requested 1.5x increase over the previous four')
assert.ok(POOL_3D_CONFIG.rain.minMemoryFallMs >= 700
  && POOL_3D_CONFIG.rain.maxMemoryFallMs <= 1300,
  'persisted rain must complete its full fall inside the 0.7-1.3 second acceptance window')
assert.ok(POOL_3D_CONFIG.rain.impactSlots >= 16 && POOL_3D_CONFIG.rain.impactSlots <= 24,
  'local feedback must stay inside the 16-24 active impact budget')
assert.ok(POOL_3D_CONFIG.rain.rippleLifetime >= 0.5 && POOL_3D_CONFIG.rain.rippleLifetime <= 0.9,
  'local rings must disappear within the requested lifetime')
assert.ok(POOL_3D_CONFIG.water.impulseRadius <= 0.012 * 0.55,
  'impact radius must shrink to the requested 35-55% range')
assert.ok(POOL_3D_CONFIG.water.waveCoefficient * POOL_3D_CONFIG.water.simulationStep ** 2 < 0.5,
  'height-field wave coefficient must stay inside the explicit integrator stability budget')

const event = { kind: 'recall', event_id: 'req-123', memory_ids: ['memory-1'] }
const strandA = buildStrandSpec(event, { x: 1.2, z: -0.4 })
const strandB = buildStrandSpec(event, { x: 1.2, z: -0.4 })
assert.deepEqual(strandA, strandB, 'one committed event must always produce the same strand grammar')
assert.equal(strandA.key, 'recall|req-123')
assert.ok(strandA.streakLength >= POOL_3D_CONFIG.rain.minStreakLength)
assert.ok(strandA.streakLength <= POOL_3D_CONFIG.rain.maxStreakLength)
assert.equal(stableEventHash('recall|req-123'), stableEventHash('recall|req-123'))
assert.deepEqual(advanceStrandLifecycle({ born: 1, duration: 0.5, landed: false }, 1.49),
  { progress: 0.98, landed: false, landsNow: false })
assert.deepEqual(advanceStrandLifecycle({ born: 1, duration: 0.5, landed: false }, 1.5),
  { progress: 1, landed: true, landsNow: true })
assert.deepEqual(advanceStrandLifecycle({ born: 1, duration: 0.5, landed: true }, 1.8),
  { progress: 1, landed: true, landsNow: false }, 'a strand may inject exactly one water impact')

const particle = { memory_id: 'memory-123', pr: 0.42, theta: 1.25, s: 0.8 }
const memoryStrandA = buildMemoryStrandSpec(particle, 0)
const memoryStrandB = buildMemoryStrandSpec(particle, 0)
const auxiliaryStrand = buildMemoryStrandSpec(particle, 1)
const memoryLanding = polarToWorld(particle)
assert.deepEqual(memoryStrandA, memoryStrandB, 'memory strands must be deterministic across renders')
assert.equal(memoryStrandA.source, 'memory')
assert.equal(memoryStrandA.x, memoryLanding.x, 'strand and interaction anchor must share landing X')
assert.equal(memoryStrandA.z, memoryLanding.z, 'strand and interaction anchor must share landing Z')
assert.equal(auxiliaryStrand.particle.memory_id, particle.memory_id,
  'render-only density tracks must preserve their source memory_id')
assert.ok(Math.hypot(auxiliaryStrand.x - memoryLanding.x, auxiliaryStrand.z - memoryLanding.z)
  <= POOL_3D_CONFIG.rain.maxTrackOffset + 1e-9,
  'auxiliary tracks may only make a small deterministic offset around the truthful topology')
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
  'underwater memories must stay in one shared GPU point buffer')
assert.match(anchorSource, /new THREE\.Points/,
  'persisted memory records must remain in one readable GPU point buffer')
assert.match(anchorSource, /cfg\.water\.underwaterY/,
  'memory points must be physically placed below water rather than floating above it')
assert.match(anchorSource, /depthTest:\s*false/,
  'the nearly transparent base may never occlude persisted memory points')
assert.match(anchorSource, /points\.renderOrder\s*=\s*2/,
  'persisted memory points must render after the transparent water base')
const rainSource = readFileSync(new URL('./src/pool/three/rain-system.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(rainSource, /new THREE\.Mesh/,
  'rain and contact feedback must use shared point pools rather than per-drop mesh churn')
assert.doesNotMatch(rainSource, /aPhase|segments:/,
  'rain must render independent short streaks instead of evenly spaced bead necklaces')
assert.match(rainSource, /state\.spec\.lane === 0/,
  'only the truthful lane may generate persisted-memory landing feedback')
assert.match(rainSource, /LocalImpactRipples/,
  'rain hits need a bounded local ripple pool instead of a global water texture')
const waterSource = readFileSync(new URL('./src/pool/three/water-disk.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(waterSource, /shortDash|shardMask|shardCell|microSlope|uSceneColor|uRefraction/i,
  'the final water path may not contain the rejected global streak or refraction layer')
assert.match(waterSource, /transparent:\s*true/)
assert.match(waterSource, /depthWrite:\s*false/)

console.log('ok - persisted memories render above a quiet transparent base with the rejected global streak layer absent')
