// P0-11 一审 P1-5：布局确定性回归（node web/test-layout-core.mjs，零依赖零编译）。
// 契约 #4 的可测半边：一切扰动来自稳定哈希——同输入同画面，刷新绝不重排。
import assert from 'node:assert/strict'
import { hash01, depthEase, WORLD, bubbleRadius, splatsPerMemory, hitTestOcean } from './src/ocean/layout-core.mjs'

// L1 hash01 确定性 + 值域 + salt 区分
for (const s of ['a', 'memory-uuid-1234', '', 'episode:x']) {
  assert.equal(hash01(s, 7), hash01(s, 7), 'L1 deterministic')
  assert.ok(hash01(s, 7) >= 0 && hash01(s, 7) <= 1, 'L1 in [0,1]')
}
assert.notEqual(hash01('same', 1), hash01('same', 2), 'L1 salt separates')
assert.notEqual(hash01('aaa', 0), hash01('aab', 0), 'L1 input separates')
console.log('PASS L1 hash01 deterministic, bounded, salted')

// L2 depthEase 单调 + 端点 + 钳制（强度越高越浅，方向不可反——一审 P1-1 的回归锚）
assert.equal(depthEase(0), 0); assert.equal(depthEase(1), 1)
assert.equal(depthEase(-5), 0); assert.equal(depthEase(9), 1, 'L2 clamped')
for (let i = 0; i < 100; i++) {
  assert.ok(depthEase(i / 100) < depthEase((i + 1) / 100), 'L2 strictly monotonic')
}
console.log('PASS L2 depthEase monotonic with clamped endpoints')

// L3 分带次序不变量（她手稿的纵向叙事顺序）
assert.ok(0 < WORLD.skyEnd && WORLD.skyEnd < WORLD.beachEnd && WORLD.beachEnd < WORLD.waterEnd && WORLD.waterEnd < 1,
  'L3 sky < beach < water < seabed')
assert.ok(WORLD.DEPTH_SCALE > 1, 'L3 the sea is deeper than one viewport')
console.log('PASS L3 band ordering invariants')

// L4 气泡半径 sqrt 扩展 + LOD 降档（一审 P1-6 的回归锚）
assert.ok(bubbleRadius(4) > bubbleRadius(1), 'L4 radius grows')
assert.ok(bubbleRadius(100) - bubbleRadius(99) < bubbleRadius(2) - bubbleRadius(1), 'L4 sublinear growth')
assert.equal(bubbleRadius(10000), 0.1, 'L4 capped')
assert.ok(splatsPerMemory(5) > splatsPerMemory(20), 'L4 LOD sheds splats under density')
assert.equal(splatsPerMemory(500), 3, 'L4 LOD floor')
console.log('PASS L4 sqrt bubble radius + density LOD')

// L5 命中检测的相机诚实性（二审 Block 项回归）：目标相机瞬移、平滑未收敛时，
// 命中必须按【实际绘制的 painted 相机】算——即画面在哪，手就点哪。
{
  const rectW = 1000, rectH = 600
  const worldH = rectH * WORLD.DEPTH_SCALE                    // 2700
  const mem = { m: { memory_id: 'm1' } }
  const placed = [{ episode_id: 'ep', cx: 0.5, cy: 0.5, cr: 0.05,
    memories: [{ ...mem, x: 0.5, y: 0.5, r: 1, bleached: false }] }]
  const paintedCam = 0.4                                      // 画面还停在 0.4
  const targetCam = 1.0                                       // 用户已把滚动甩到底
  const sy = 0.5 * worldH - paintedCam * (worldH - rectH)     // 记忆在当前画面上的真实位置
  assert.ok(sy > 0 && sy < rectH, 'L5 fixture memory is on the painted screen')
  const hitPainted = hitTestOcean(placed, 500, sy, rectW, rectH, paintedCam)
  assert.equal(hitPainted?.placed.m.memory_id, 'm1', 'L5 pointer on the visible particle hits it (painted cam)')
  const hitTarget = hitTestOcean(placed, 500, sy, rectW, rectH, targetCam)
  assert.equal(hitTarget, null, 'L5 same pointer with TARGET cam would miss: proves target cam must never be used')
  const offscreen = hitTestOcean(placed, 500, 100, rectW, rectH, paintedCam)
  assert.equal(offscreen, null, 'L5 pointer away from the particle hits nothing')
}
console.log('PASS L5 hit-test reads the painted camera, never the target')

console.log('ALL LAYOUT CORE TESTS PASSED')
