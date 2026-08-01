// P0-09 round-2 单测：夜间 handler 的 terminal/nonterminal 裁决（P0-2 修复的回归卷）。
// 无 DB/无 AWS：makeHandler 注入假 runNightly，逐态验证 reject 语义与同 event 重试收口。
import './lib/test-env.mjs'
import assert from 'node:assert/strict'
import { makeHandler } from './aws/nightly-handler.mjs'

const EV = { time: '2026-08-01T19:00:37.123Z' }
const CANON = '2026-08-01T19:00:00.000Z'
const ok = (job) => ({ outcome: 'completed', dream: { outcome: 'completed' }, reflection: { outcome: 'completed' }, transition: { outcome: 'completed' }, ...job })
delete process.env.TIDEMARK_NIGHTLY_TENANTS

// ===== H1 canonical 取整 + 手动覆盖 =====
{
  let seen
  const h = makeHandler({ runNightly: async ({ scheduledFor }) => { seen = scheduledFor; return ok() } })
  const r = await h(EV)
  assert.equal(seen, CANON, 'event.time floors to the minute')
  assert.equal(r.scheduled_for, CANON)
  await h({ scheduled_for: '2026-08-02T03:15:00.000Z' })
  assert.equal(seen, '2026-08-02T03:15:00.000Z', 'manual scheduled_for wins verbatim')
  await assert.rejects(() => h({}), /must carry time/)
  await assert.rejects(() => h({ time: 'garbage' }), /unparseable/)
  console.log('PASS H1 canonicalization + manual override + bad event rejection')
}

// ===== H2 全终态 completed：成功返回 =====
{
  const h = makeHandler({ runNightly: async () => ok() })
  const r = await h(EV)
  assert.equal(r.results[0].top, 'completed')
  assert.deepEqual(r.results[0].pending, [])
  console.log('PASS H2 all-terminal night returns success')
}

// ===== H3-H5 三个 job 的每种非终态都必须让整次 invoke 失败 =====
const NONTERMINAL = ['retryable', 'stale', 'lease_held', 'refused_future_evaluation', 'crashed']
{
  for (const o of NONTERMINAL) {
    // dream 非终态：orchestrator 真实形状是 short_circuited_at_dream 且无 reflection/transition
    const hD = makeHandler({ runNightly: async () => ({ outcome: 'short_circuited_at_dream', dream: { outcome: o } }) })
    await assert.rejects(() => hD(EV), (e) => e.message.includes(`dream:${o}`), `dream ${o} must reject`)
    // reflection 非终态：orchestrator 包成 completed_degraded 继续跑 transition
    const hR = makeHandler({ runNightly: async () => ok({ outcome: 'completed_degraded', reflection: { outcome: o } }) })
    await assert.rejects(() => hR(EV), (e) => e.message.includes(`reflection:${o}`), `reflection ${o} must reject`)
    // transition 非终态：顶层仍可能是 completed
    const hT = makeHandler({ runNightly: async () => ok({ transition: { outcome: o } }) })
    await assert.rejects(() => hT(EV), (e) => e.message.includes(`transition:${o}`), `transition ${o} must reject`)
  }
  console.log(`PASS H3-H5 every nonterminal state rejects across all three jobs (${NONTERMINAL.length}x3)`)
}

// ===== H5b 未知状态/畸形结果默认 reject（round-3 P1，Codex 两例实跑反例）=====
{
  // 反例1：拼写漂移的未知 job 态（黑名单时代会被当 terminal 吞掉）
  const hU = makeHandler({ runNightly: async () => ok({ dream: { outcome: 'retrying' } }) })
  await assert.rejects(() => hU(EV), (e) => e.message.includes('dream:retrying'), 'unknown job state must reject')
  // 反例2：runNightly 返回 {}——top 与三 job 全缺
  const hE = makeHandler({ runNightly: async () => ({}) })
  await assert.rejects(() => hE(EV), (e) =>
    e.message.includes('top:missing') && e.message.includes('dream:missing')
    && e.message.includes('reflection:missing') && e.message.includes('transition:missing'),
    'empty result must reject on top + all three jobs')
  // 未知 top 值
  const hT = makeHandler({ runNightly: async () => ok({ outcome: 'totally_new_shape' }) })
  await assert.rejects(() => hT(EV), (e) => e.message.includes('top:totally_new_shape'))
  console.log('PASS H5b unknown states and malformed results reject by default (terminal allowlist)')
}

// ===== H5c 拓扑校验：completed 形状缺 job 拒；short_circuited 合法缺席不误伤 =====
{
  const noTrans = ok(); delete noTrans.transition
  const hM = makeHandler({ runNightly: async () => noTrans })
  await assert.rejects(() => hM(EV), (e) => e.message.includes('transition:missing'), 'completed shape requires all three jobs')
  // short_circuited：reflection/transition 缺席合法，只对 dream 的非终态报数
  const hS = makeHandler({ runNightly: async () => ({ outcome: 'short_circuited_at_dream', dream: { outcome: 'lease_held' } }) })
  await assert.rejects(() => hS(EV), (e) =>
    e.message.includes('dream:lease_held') && !e.message.includes('reflection:missing') && !e.message.includes('transition:missing'),
    'short-circuit shape must not false-flag absent downstream jobs')
  console.log('PASS H5c topology: required jobs enforced, short-circuit absences legal')
}

// ===== H6 runNightly 异常 -> tenant crashed -> 整次失败 =====
{
  const h = makeHandler({ runNightly: async () => { throw new Error('boom') } })
  await assert.rejects(() => h(EV), /orchestrator:crashed/)
  console.log('PASS H6 orchestrator exception becomes crashed and rejects')
}

// ===== H7 多 tenant 尽力完成：首 tenant 非终态不拦后续 tenant，最后统一失败 =====
{
  process.env.TIDEMARK_NIGHTLY_TENANTS = 't-a,t-b'
  const ran = []
  const h = makeHandler({ runNightly: async ({ tenantId }) => {
    ran.push(tenantId)
    if (tenantId === 't-a') return { outcome: 'short_circuited_at_dream', dream: { outcome: 'lease_held' } }
    return ok()
  } })
  await assert.rejects(() => h(EV), (e) => e.message.includes('t-a[dream:lease_held]') && !e.message.includes('t-b['))
  assert.deepEqual(ran, ['t-a', 't-b'], 'both tenants ran before the verdict')
  delete process.env.TIDEMARK_NIGHTLY_TENANTS
  console.log('PASS H7 best-effort across tenants, single honest verdict')
}

// ===== H8 同 event 重试收口：第二次全终态 -> 成功 =====
{
  let n = 0
  const h = makeHandler({ runNightly: async () => {
    n++
    if (n === 1) return ok({ outcome: 'completed_degraded', reflection: { outcome: 'retryable' } })
    return ok()
  } })
  await assert.rejects(() => h(EV))
  const r = await h(EV)
  assert.equal(r.results[0].pending.length, 0)
  console.log('PASS H8 retry with the same event converges to success')
}

// ===== H9 terminal failed 是诚实 degraded 成功，不触发重试风暴 =====
{
  const h = makeHandler({ runNightly: async () => ok({ outcome: 'completed_degraded', dream: { outcome: 'failed' }, reflection: { outcome: 'failed_terminal' } }) })
  const r = await h(EV)
  assert.equal(r.results[0].top, 'completed_degraded')
  assert.deepEqual(r.results[0].pending, [])
  console.log('PASS H9 terminal failures return honest degraded success')
}

console.log('ALL P0-09 NIGHTLY-HANDLER ASSERTIONS PASSED (H1-H9 incl. H5b/H5c)')
