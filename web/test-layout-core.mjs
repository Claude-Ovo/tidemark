// P0-11 一审 P1-5：布局确定性回归（node web/test-layout-core.mjs，零依赖零编译）。
// 契约 #4 的可测半边：一切扰动来自稳定哈希——同输入同画面，刷新绝不重排。
import assert from 'node:assert/strict'
import { hash01, depthEase, WORLD, bubbleRadius, splatsPerMemory } from './src/ocean/layout-core.mjs'

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

console.log('ALL LAYOUT CORE TESTS PASSED')
