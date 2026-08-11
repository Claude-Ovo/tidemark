import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { POOL_3D_CONFIG, cappedPixelRatio, fittedVerticalFov, polarToWorld } from './src/pool/three/config.mjs'
import { createNozzleLayout } from './src/pool/three/fountain-system.mjs'
import { mergeHeightFieldImpulses, worldToFieldUv } from './src/pool/three/height-field.mjs'
import { createRadialDiskGeometry } from './src/pool/three/water-disk.mjs'

assert.equal(cappedPixelRatio(3), 1.5)
assert.equal(fittedVerticalFov(1.6), POOL_3D_CONFIG.camera.fov)
assert.ok(fittedVerticalFov(0.6) > POOL_3D_CONFIG.camera.fov)
assert.deepEqual(polarToWorld({ r: 0.5, theta: 0 }), { x: 2.5, y: 0.055, z: 0 })

const nozzles = createNozzleLayout()
const inner = nozzles.filter(nozzle => nozzle.tier === 0)
const active = nozzles.filter(nozzle => nozzle.tier === 1)
assert.equal(inner.length, 24, 'inner consolidated ring must use 24 nozzles')
assert.equal(active.length, 38, 'active ring must use 38 nozzles')
assert.equal(nozzles.filter(nozzle => nozzle.tier === 2).length, 0, 'receding ring must never create jets')
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const innerMean = mean(inner.map(nozzle => nozzle.height))
const activeMean = mean(active.map(nozzle => nozzle.height))
assert.ok(activeMean / innerMean >= 0.55 && activeMean / innerMean <= 0.65,
  'active jets must remain 55-65% of consolidated height')
assert.ok(inner.every(nozzle => Math.abs(nozzle.height / POOL_3D_CONFIG.fountain.innerHeight - 1) <= 0.08),
  'inner jet variation must stay within eight percent')

const uv = worldToFieldUv(0, 0, 6.25)
assert.deepEqual(uv, { u: 0.5, v: 0.5 })
const merged = mergeHeightFieldImpulses([
  { u: 0.501, v: 0.501, radius: 0.01, strength: 0.2 },
  { u: 0.502, v: 0.502, radius: 0.02, strength: 0.4 },
], 64)
assert.equal(merged.length, 1)
assert.ok(Math.abs(merged[0].strength - 0.6) < 1e-9)
assert.equal(merged[0].eventCount, 2)

const disk = createRadialDiskGeometry(5, 4, 16)
assert.equal(disk.getAttribute('position').count, 65)
assert.equal(disk.index.count, 336)
disk.dispose()

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const tideSource = source('./src/pool/three/tide-pool-3d.mjs')
const fountainSource = source('./src/pool/three/fountain-system.mjs')
const cameraSource = source('./src/pool/three/camera-rig.mjs')
const pointSource = source('./src/pool/three/data-model-group.mjs')
const waterSource = source('./src/pool/three/water-disk.mjs')
const poolSource = source('./pool.html')

assert.doesNotMatch(tideSource, /rain-system|createRainSystem|\.pick\(/,
  'the final 3D path must not retain rain creation, collision or picking')
assert.doesNotMatch(tideSource, /syncDrops/,
  'the final 3D API must not expose a legacy falling-drop path')
assert.doesNotMatch(cameraSource, /OrbitControls|autoRotate|pointerdown|dblclick|damping/,
  'the presentation camera must remain completely fixed')
assert.match(fountainSource, /new THREE\.Points/)
assert.match(fountainSource, /new THREE\.LineSegments/)
assert.doesNotMatch(fountainSource, /new THREE\.Mesh|PointLight|AdditiveBlending/,
  'fountain water must use shared non-additive line and point apparatus')
assert.match(pointSource, /8 \+ strength \* 3/,
  'memory points must remain within the 8-11 CSS-pixel contract')
assert.match(pointSource, /id === hoveredId \? 1\.3/)
assert.doesNotMatch(pointSource, /halo|AdditiveBlending|emissive|uTime/,
  'truthful memory points must be static, sharp and non-emissive')
assert.match(pointSource, /renderOrder = 20/)
assert.match(poolSource, /width: 36px; height: 36px/)
assert.match(poolSource, /width: 44px; height: 44px/)
assert.match(poolSource, /nearestParticleAt/)
const waterCode = waterSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
assert.doesNotMatch(waterCode, /scanline|grid|caustic|normal noise/i,
  'water material must not reintroduce a global repeated decoration layer')

console.log('pool 3d fountain tests: ok')
