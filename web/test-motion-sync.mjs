// motion-sync 判别（动效批一审 P1-1 的三反例 + 消费语义）。零 DOM：
// 命中层契约是"draw 帧末 placeBtn(anchorXY(p)) 消费 dirty 集"——placeBtn 由 anchorXY
// 纯派生，故判别只需钉死【三条路径都把粒子留在 dirty 集、且消费前不丢失】。
// M1 Codex 反例①：后台 tab 恢复，单帧跨过整段 dur——完成帧粒子必须在 dirty 里
// M2 Codex 反例②：动画中切 reduced——reduceFlush 直落终态且标 dirty
// M3 Codex 反例③：快照只改 theta 不改 r——thetaUpdate 必须标 dirty；同值不标
// M4 逐帧迁移：每帧标 dirty，消费即清，完成后 tween 移除、不再产生标记
// M5 REDUCED migrate 直落也标 dirty；consumeDirty 只清一次（跨 step 持久）
import { strict as assert } from 'node:assert'
import { makeMotionState, MOTION } from './src/pool/motion-sync.mjs'

let pass = 0
const ok = (name) => { pass++; console.log(`ok - ${name}`) }
const P = (over = {}) => ({ memory_id: 'm', theta: 1, r: 0.5, pr: 0.5, markR: 0.008, layer: 'active_tide', ...over })

// M1 单帧跨过整段 dur（后台 tab 恢复）
{
  const m = makeMotionState()
  const p = P()
  m.migrate(p, 0.3, { now: 1000 })
  m.step(1000 + MOTION.MIGRATE_MS + 3500)            // 一帧直接跨 5s
  assert.equal(p.pr, 0.3, '完成帧必须落在终态')
  assert.ok(m.consumeDirty().includes(p), '完成帧粒子必须在 dirty 集（tween 已被移除也一样）')
  assert.equal(m.active(), false)
  m.step(1000 + MOTION.MIGRATE_MS + 3600)
  assert.equal(m.consumeDirty().length, 0, '完成后不再产生标记')
  ok('M1 单帧跨完整段 dur：终态 + dirty 不丢')
}

// M2 动画中切 reduced
{
  const m = makeMotionState()
  const a = P({ memory_id: 'a' }), b = P({ memory_id: 'b', pr: 0.7, r: 0.7 })
  m.migrate(a, 0.2, { now: 0 })
  m.migrate(b, 0.9, { now: 0 })
  m.step(300)                                        // 动画中途
  m.consumeDirty()                                   // 中途帧已消费
  m.reduceFlush()
  assert.equal(a.pr, 0.2); assert.equal(b.pr, 0.9)
  const d = m.consumeDirty()
  assert.ok(d.includes(a) && d.includes(b), '切 reduced：在途 tween 粒子直落终态并全部标 dirty')
  assert.equal(m.active(), false)
  ok('M2 动画中切 reduced：直落终态 + dirty')
}

// M3 theta-only relayout（Codex 实测 2.4 rad 反例的抽象）
{
  const m = makeMotionState()
  const p = P({ theta: 4.808933 })
  m.thetaUpdate(p, 2.408970)
  assert.equal(p.theta, 2.408970)
  assert.ok(m.consumeDirty().includes(p), 'theta 变更必须标 dirty（r 不变、无 tween）')
  m.thetaUpdate(p, 2.408970)
  assert.equal(m.consumeDirty().length, 0, '同值不标')
  ok('M3 theta-only relayout：标 dirty，同值零标记')
}

// M4 逐帧迁移：每帧标记、消费即清、可中断 retarget 不回跳
{
  const m = makeMotionState()
  const p = P()
  m.migrate(p, 0.3, { now: 0 })
  m.step(500)
  const mid = p.pr
  assert.ok(mid < 0.5 && mid > 0.3, '中途值在两端之间')
  assert.ok(m.consumeDirty().includes(p))
  assert.equal(m.consumeDirty().length, 0, '消费即清')
  m.migrate(p, 0.45, { now: 600 })                   // 中断 retarget
  m.step(601)
  assert.ok(Math.abs(p.pr - mid) < 0.01, 'retarget 从当前呈现值起算，不回跳')
  assert.ok(m.consumeDirty().includes(p))
  ok('M4 逐帧标记 + 消费即清 + 可中断不回跳')
}

// M5 REDUCED 直落 + dirty 跨 step 持久（未消费不丢）
{
  const m = makeMotionState()
  const p = P()
  m.migrate(p, 0.1, { reduced: true, now: 0 })
  assert.equal(p.pr, 0.1)
  m.step(16); m.step(32)                             // 两帧过去都没消费
  assert.ok(m.consumeDirty().includes(p), 'dirty 跨 step 持久，直到消费')
  // grow/enter 终态钳位
  const g = P({ memory_id: 'g' })
  m.grow(g, 0)
  m.step(MOTION.ATTACH_GROW_MS + 50)
  assert.equal(g.mrScale, 1)
  const e = P({ memory_id: 'e' })
  m.enter(e, 100)                                    // 未来 t0=延迟
  m.step(50)
  assert.equal(e.alpha, 0, '延迟未到保持 0')
  m.step(100 + MOTION.ENTRANCE_MS + 10)
  assert.equal(e.alpha, 1)
  assert.equal(m.active(), false)
  ok('M5 REDUCED 标 dirty 持久 + grow/enter 终态钳位')
}

console.log(`motion-sync 判别 ${pass}/5 全绿`)
