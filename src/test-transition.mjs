// P0-06 验收 round-2：node --env-file=.env src/test-transition.mjs（S2/S3 需先起 server，EMBED_PROVIDER=stub）
// 一审整改：场景独立 tenant + 真实当下 evaluation（不再用未来日期隔离唯一键——生产入口已装
// future guard）；S3 经真实 report_outcome/pin 断言 credited/blamed/revive/unpin 的时钟同源性；
// S10 用真实 canonical fingerprint；S14 断言 DB pipeline_version 编码实际 batch；S16 future 反例；
// S17 frozen config 越权反例。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'
import { scheduleNext, TRANSITION_CFG } from './lib/scheduler.mjs'
import { runTransition, claimRun, executeRun, pipelineVersionOf } from './nightly/transition.mjs'

let forensic = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try { forensic ??= await connectWithRetry(cs, { label: 'forensic' }); return await forensic.query(text, params) }
    catch (e) { await forensic?.end().catch(() => {}); forensic = null; if (!isRetryableDatabaseError(e) || attempt >= 5) throw e; await sleep(800 * attempt) }
  }
}
const url = process.env.TIDEMARK_URL || 'http://localhost:3901'
const withClient = async (fn) => {
  const c = new Client({ name: 'p006-test', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { 'x-tidemark-auth': 'spike-demo-key' } } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args })
  return JSON.parse(r.content[0].text)
}

const suite = 'p006-' + randomUUID().slice(0, 8)
const t = (n) => `${suite}-t${n}`                          // 每场景独立 tenant：唯一键天然隔离，evaluation 全用真实当下
const A = suite + '-agent'
const DEMO_T = 'demo-tenant'
const eps = new Set(), rids = new Set(), attempts = new Set()
const ep = () => { const e = `${suite}-ep-` + randomUUID().slice(0, 6); eps.add(e); return e }
const rid = () => { const r = randomUUID(); rids.add(r); return r }
const att = () => { const a = `${suite}-att-` + randomUUID().slice(0, 6); attempts.add(a); return a }
const EMB = '[' + Array(512).fill('0.01').join(',') + ']'
const HOUR = 3600e3
const nowIso = () => new Date().toISOString()               // 真实当下：guard 容差内

const ins = async (tenant, { state = 'fresh', pinned = false, admission = 'accepted', anchor = 1.0, anchorAtH = 0,
                             halfLife = 108, count = 0, baseline = 0, nextH = null } = {}) => {
  const id = randomUUID()
  await q(
    `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, source, admission,
       state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
       credited_success_count, consolidation_baseline, next_transition_at)
     VALUES ($1,$2,$3,'event',$4,$5,$6,'agent_inferred',$7,$8,$9,0.5,$10, now()+($11::FLOAT8||' hours')::INTERVAL, now(),
       $12,$13,$14, CASE WHEN $15::FLOAT8 IS NULL THEN NULL ELSE now()+($15::FLOAT8||' hours')::INTERVAL END)`,
    [tenant, A, id, `${suite}-direct`, `row ${id.slice(0, 8)}`, admission === 'accepted' ? EMB : null, admission,
     state, pinned, anchor, anchorAtH, halfLife, count, baseline, nextH])
  return id
}
const row = async (id, tenant) => (await q(
  'SELECT state, pinned, strength_anchor, strength_anchor_at, half_life_hours, credited_success_count, consolidation_baseline, next_transition_at, revision FROM memories WHERE tenant_id=$1 AND memory_id=$2',
  [tenant, id])).rows[0]

// 时钟同源断言：next_transition_at 必须精确等于用行内 anchor_at/anchor 重算的解析解
// （writer 双时钟修复后两者来自同一 DB 时刻——不再有机器钟漂移）
const assertNextConsistent = (m, label) => {
  const recomputed = scheduleNext({ admission: 'accepted', pinned: m.pinned, state: m.state,
    strength_anchor: m.strength_anchor, strength_anchor_at: m.strength_anchor_at,
    half_life_hours: m.half_life_hours, credited_success_count: m.credited_success_count,
    consolidation_baseline: m.consolidation_baseline }, m.strength_anchor_at.getTime())
  if (recomputed === null) { assert.equal(m.next_transition_at, null, label); return }
  assert.ok(Math.abs(m.next_transition_at.getTime() - recomputed.getTime()) < 100,
    `${label}: stored next(${m.next_transition_at?.toISOString()}) == recomputed from stored anchor (${recomputed.toISOString()})`)
}

// demo-tenant 真实塑性链：remember -> recall -> memory_used 证据（S3 用）
const buildCitable = async (c, { content, episode, attemptId, taskId }) => {
  const rem = await call(c, 'remember', { content, episode_id: episode, request_id: rid() })
  assert.equal(rem.ok, true, JSON.stringify(rem))
  const rrId = rid()
  const rec = await call(c, 'recall', { query: content, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: rrId })
  const item = rec.receipt.items.find(i => i.memory_id === rem.memory_id && i.injected)
  assert.ok(item, 'injected item to cite')
  const ev = await call(c, 'log_event', { episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, request_id: rid(),
    event_type: 'memory_used', payload: { recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: item.memory_id } })
  return { memory_id: rem.memory_id, recall_request_id: rrId, receipt_item_id: item.receipt_item_id, evidence_event_id: ev.event_id }
}

let primaryError = null
try {
  // S1 scheduler 纯函数：全分支
  {
    const now = Date.now()
    const b = { admission: 'accepted', pinned: false, state: 'fresh', strength_anchor: 1.0,
                strength_anchor_at: new Date(now), half_life_hours: 108, credited_success_count: 0, consolidation_baseline: 0 }
    assert.equal(scheduleNext({ ...b, admission: 'quarantined' }, now), null)
    assert.equal(scheduleNext({ ...b, pinned: true }, now), null)
    assert.equal(scheduleNext({ ...b, state: 'faded' }, now), null)
    assert.equal(scheduleNext({ ...b, credited_success_count: 3 }, now).getTime(), now)
    assert.equal(scheduleNext({ ...b, credited_success_count: 5, consolidation_baseline: 3 }, now).getTime() > now, true)
    assert.equal(scheduleNext({ ...b, strength_anchor: 0.15 }, now).getTime(), now)
    const expected = now + 108 * Math.log2(1.0 / 0.15) * HOUR
    assert.ok(Math.abs(scheduleNext(b, now).getTime() - expected) < 1000)
    assert.ok(scheduleNext({ ...b, strength_anchor_at: new Date(now - 500 * HOUR), strength_anchor: 0.5 }, now).getTime() < now)
    assert.equal(scheduleNext({ ...b, credited_success_count: 3, strength_anchor: 0.99 }, now).getTime(), now)
    console.log('PASS S1 scheduler pure-function branches')
  }

  // S2 remember 初始化 = 解析值（SQL 表达式与 JS scheduler 同源）
  {
    let memId
    await withClient(async (c) => {
      const r = await call(c, 'remember', { content: 'p006 sched probe ' + suite, episode_id: ep(), request_id: rid() })
      memId = r.memory_id
    })
    const m = await row(memId, DEMO_T)
    assert.ok(m.next_transition_at, 'remember initializes next_transition_at')
    assertNextConsistent(m, 'remember')
    console.log('PASS S2 remember initialization matches canonical scheduler')
  }

  // S3 写点时钟同源（一审#2 验收）：credited / blamed / revive / pin / unpin 五路
  {
    await withClient(async (c) => {
      // credited：加固后 stored anchor_at 与 next 严格同源
      const ep1 = ep(), at1 = att(), task1 = suite + '-s3a'
      const cit1 = await buildCitable(c, { content: 's3 credited ' + suite, episode: ep1, attemptId: at1, taskId: task1 })
      await q(`UPDATE memories SET strength_anchor=0.5, strength_anchor_at=now() - INTERVAL '48 hours', last_rewarded_at=now() - INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [DEMO_T, cit1.memory_id])
      const r1 = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: ep1, task_instance_id: task1, attempt_id: at1, status: 'success', attributions: [{ ...cit1, role: 'credited' }] })
      assert.equal(r1.ok, true, JSON.stringify(r1))
      assertNextConsistent(await row(cit1.memory_id, DEMO_T), 'credited reschedule')
      // blamed：降权后同源
      const ep2 = ep(), at2 = att(), task2 = suite + '-s3b'
      const cit2 = await buildCitable(c, { content: 's3 blamed ' + suite, episode: ep2, attemptId: at2, taskId: task2 })
      const r2 = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: ep2, task_instance_id: task2, attempt_id: at2, status: 'failure', attributions: [{ ...cit2, role: 'blamed' }] })
      assert.equal(r2.ok, true, JSON.stringify(r2))
      assertNextConsistent(await row(cit2.memory_id, DEMO_T), 'blamed reschedule')
      // revive：faded -> credited 复活，baseline=复活后 count（复活不计进度）+ 同源
      const ep3 = ep(), at3 = att(), task3 = suite + '-s3c'
      const cit3 = await buildCitable(c, { content: 's3 revive ' + suite, episode: ep3, attemptId: at3, taskId: task3 })
      await q(`UPDATE memories SET state='faded', next_transition_at=NULL WHERE tenant_id=$1 AND memory_id=$2`, [DEMO_T, cit3.memory_id])
      const r3 = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: ep3, task_instance_id: task3, attempt_id: at3, status: 'success', attributions: [{ ...cit3, role: 'credited' }] })
      assert.equal(r3.items[0].plasticity.revived, true, JSON.stringify(r3))
      const m3 = await row(cit3.memory_id, DEMO_T)
      assert.equal(m3.state, 'fresh')
      assert.equal(Number(m3.consolidation_baseline), Number(m3.credited_success_count), 'revive: baseline = post-revival count (no progress from the reviving credit)')
      assertNextConsistent(m3, 'revive reschedule')
      // pin -> NULL；unpin 攒满 progress 立即 due
      const pr = await call(c, 'remember', { content: 's3 pin ' + suite, episode_id: ep(), request_id: rid() })
      await call(c, 'pin', { memory_id: pr.memory_id, pinned: true, reason: 'unit', request_id: rid() })
      assert.equal((await row(pr.memory_id, DEMO_T)).next_transition_at, null, 'pin -> NULL')
      await q('UPDATE memories SET credited_success_count=3, consolidation_baseline=0 WHERE tenant_id=$1 AND memory_id=$2', [DEMO_T, pr.memory_id])
      await call(c, 'pin', { memory_id: pr.memory_id, pinned: false, reason: 'unit', request_id: rid() })
      const mu = await row(pr.memory_id, DEMO_T)
      assert.ok(mu.next_transition_at && Math.abs(mu.next_transition_at.getTime() - mu.strength_anchor_at.getTime()) < 100, 'unpin with earned progress -> due at the same tx clock')
    })
    console.log('PASS S3 write-point clock coherence (credited/blamed/revive/pin/unpin)')
  }

  // S4 fade 闭环
  {
    const T4 = t(4)
    const id = await ins(T4, { anchor: 0.5, anchorAtH: -200, count: 2, nextH: -1 })
    const r = await runTransition({ tenantId: T4, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.counts.fade, 1)
    const m = await row(id, T4)
    assert.equal(m.state, 'faded'); assert.equal(m.next_transition_at, null)
    assert.equal(Number(m.consolidation_baseline), 2, 'fade resets progress (baseline=count)')
    console.log('PASS S4 fade transition + progress reset')
  }

  // S5 consolidate：materialize-then-multiply、曲线连续
  {
    const T5 = t(5)
    const id = await ins(T5, { anchor: 1.0, anchorAtH: -10, count: 3, nextH: -1 })
    const evalIso = nowIso()
    const evalMs = new Date(evalIso).getTime()
    const before = await row(id, T5)
    const effExpected = 1.0 * Math.exp(-Math.LN2 * ((evalMs - before.strength_anchor_at.getTime()) / HOUR) / 108)
    const r = await runTransition({ tenantId: T5, scheduledFor: evalIso })
    assert.equal(r.counts.consolidate, 1, JSON.stringify(r))
    const m = await row(id, T5)
    assert.equal(m.state, 'consolidated')
    assert.equal(Number(m.half_life_hours), 324)
    assert.ok(Math.abs(Number(m.strength_anchor) - effExpected) < 1e-6, 'curve continuity at evaluation')
    assert.equal(m.strength_anchor_at.getTime(), evalMs, 'anchor_at == evaluation_at')
    assert.equal(Number(m.consolidation_baseline), 3)
    console.log('PASS S5 consolidation: materialize-then-multiply, curve continuous')
  }

  // S6 fade 胜 consolidate
  {
    const T6 = t(6)
    const id = await ins(T6, { anchor: 0.5, anchorAtH: -200, count: 3, nextH: -1 })
    const r = await runTransition({ tenantId: T6, scheduledFor: nowIso() })
    assert.equal(r.counts.fade, 1); assert.equal(r.counts.consolidate, 0)
    assert.equal((await row(id, T6)).state, 'faded')
    console.log('PASS S6 fade beats consolidate')
  }

  // S7 阈值等值：<= 口径一次 fade，随后 no_work（零热循环）
  {
    const T7 = t(7)
    const id = await ins(T7, { anchor: 0.15, anchorAtH: 0, nextH: -1 })
    const r1 = await runTransition({ tenantId: T7, scheduledFor: nowIso() })
    assert.ok(r1.counts.fade >= 1)
    assert.equal((await row(id, T7)).state, 'faded')
    const r2 = await runTransition({ tenantId: T7, scheduledFor: nowIso() })
    assert.equal(r2.outcome, 'no_work', JSON.stringify(r2))
    console.log('PASS S7 threshold-equality fades once, no hot loop')
  }

  // S8 no-work 不落 run 行
  {
    const T8 = t(8)
    const r = await runTransition({ tenantId: T8, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'no_work')
    const n = (await q('SELECT count(*)::INT4 AS n FROM nightly_runs WHERE tenant_id=$1', [T8])).rows[0].n
    assert.equal(n, 0)
    console.log('PASS S8 no-work writes no run row')
  }

  // S9 同 scheduled_for 幂等重跑
  {
    const T9 = t(9)
    const id = await ins(T9, { anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = nowIso()
    const r1 = await runTransition({ tenantId: T9, scheduledFor: s })
    assert.equal(r1.outcome, 'completed')
    const rev = Number((await row(id, T9)).revision)
    const r2 = await runTransition({ tenantId: T9, scheduledFor: s })
    assert.equal(r2.outcome, 'already_completed', JSON.stringify(r2))
    assert.equal(Number((await row(id, T9)).revision), rev, 'zero re-transitions')
    console.log('PASS S9 same scheduled_for is idempotent')
  }

  // S10 真实 canonical fingerprint 的 failed run 不卡队列
  {
    const T10 = t(10)
    const id = await ins(T10, { anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = new Date().toISOString()
    const claim = await claimRun(T10, s, TRANSITION_CFG)   // 真实 claim：真实 snapshot/fingerprint
    assert.equal(claim.outcome, 'claimed')
    await q(`UPDATE nightly_runs SET status='failed', error_code='attempts_exhausted' WHERE tenant_id=$1 AND run_id=$2`, [T10, claim.run_id])
    const r1 = await runTransition({ tenantId: T10, scheduledFor: s })
    assert.equal(r1.outcome, 'failed_terminal', 'same key returns terminal failed')
    const r2 = await runTransition({ tenantId: T10, scheduledFor: nowIso() })
    assert.equal(r2.outcome, 'completed', JSON.stringify(r2))
    assert.equal((await row(id, T10)).state, 'faded', 'next night reclaims -- queue never wedged')
    console.log('PASS S10 failed run (real fingerprint) does not wedge the queue')
  }

  // S11 revision mismatch -> 整批 stale 零写入 -> reacquire generation+1 -> completed
  {
    const T11 = t(11)
    const id = await ins(T11, { anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = new Date().toISOString()
    const claim = await claimRun(T11, s, TRANSITION_CFG)
    assert.equal(claim.outcome, 'claimed')
    await q('UPDATE memories SET revision=revision+1 WHERE tenant_id=$1 AND memory_id=$2', [T11, id])
    const revBefore = Number((await row(id, T11)).revision)
    const ex = await executeRun(T11, s, claim)
    assert.equal(ex.outcome, 'stale', JSON.stringify(ex))
    assert.equal(Number((await row(id, T11)).revision), revBefore, 'stale batch wrote nothing')
    const r = await runTransition({ tenantId: T11, scheduledFor: s })
    assert.equal(r.outcome, 'completed')
    const run = (await q(`SELECT attempt_count, status FROM nightly_runs WHERE tenant_id=$1`, [T11])).rows[0]
    assert.equal(Number(run.attempt_count), 2, 'reacquire bumped generation')
    assert.equal((await row(id, T11)).state, 'faded')
    console.log('PASS S11 stale batch zero-write, reacquire completes')
  }

  // S12 fencing：generation token 不符 -> 提交必败、整体回滚
  {
    const T12 = t(12)
    const id = await ins(T12, { anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = new Date().toISOString()
    const claim = await claimRun(T12, s, TRANSITION_CFG)
    await q(`UPDATE nightly_runs SET attempt_count=attempt_count+1 WHERE tenant_id=$1 AND run_id=$2`, [T12, claim.run_id])
    const revBefore = Number((await row(id, T12)).revision)
    await assert.rejects(() => executeRun(T12, s, claim), /fencing_violation/)
    assert.equal(Number((await row(id, T12)).revision), revBefore, 'fencing rollback: memories untouched')
    console.log('PASS S12 lease fencing: old worker cannot double-commit')
  }

  // S13 future anchor -> run failed 停机
  {
    const T13 = t(13)
    const id = await ins(T13, { anchor: 0.8, anchorAtH: 48, nextH: -1 })
    const r = await runTransition({ tenantId: T13, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'failed', JSON.stringify(r))
    assert.equal(r.reason, 'future_anchor')
    assert.equal((await row(id, T13)).state, 'fresh', 'contaminated row untouched')
    const run = (await q(`SELECT status, error_code FROM nightly_runs WHERE tenant_id=$1`, [T13])).rows[0]
    assert.equal(run.status, 'failed'); assert.equal(run.error_code, 'future_anchor')
    console.log('PASS S13 future anchor fails the run closed')
  }

  // S14 batch 有界顺延 + pipeline_version 编码实际 batch（一审#3 验收）
  {
    const T14 = t(14)
    for (let i = 0; i < 5; i++) await ins(T14, { anchor: 0.5, anchorAtH: -200, nextH: -2 + i * 0.01 })
    const small = { ...TRANSITION_CFG, batch_size: 3 }
    const s1 = nowIso()
    const r1 = await runTransition({ tenantId: T14, scheduledFor: s1, cfg: small })
    assert.equal(r1.counts.fade, 3, JSON.stringify(r1.counts))
    const ver = (await q(`SELECT pipeline_version FROM nightly_runs WHERE tenant_id=$1 AND scheduled_for=$2`, [T14, new Date(s1).toISOString()])).rows[0].pipeline_version
    assert.ok(ver.includes('batch=3'), `run row advertises the EFFECTIVE batch: ${ver}`)
    assert.equal(ver, pipelineVersionOf(small), 'pipeline_version derived from effective cfg')
    const r2 = await runTransition({ tenantId: T14, scheduledFor: nowIso(), cfg: small })
    assert.equal(r2.counts.fade, 2, 'remainder rolls to next night')
    console.log('PASS S14 bounded batch defers remainder, version encodes effective batch')
  }

  // S15 压测：200 行 set-based 一晚处理 vs lease
  {
    const T15 = t(15)
    await q(
      `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, source, admission,
         state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
         credited_success_count, consolidation_baseline, next_transition_at)
       SELECT $1, $2, gen_random_uuid(), 'event', $3, 'bulk ' || i, $4, 'agent_inferred', 'accepted',
         'fresh', false, 0.5, 0.5, now() - INTERVAL '200 hours', now(), 108, 0, 0, now() - INTERVAL '1 hour'
       FROM generate_series(1, 200) AS g(i)`,
      [T15, A, `${suite}-bulk`, EMB])
    const t0 = Date.now()
    const r = await runTransition({ tenantId: T15, scheduledFor: nowIso() })
    const elapsed = Date.now() - t0
    assert.equal(r.counts.fade, 200)
    assert.ok(elapsed < 60_000, `far below lease: ${elapsed}ms`)
    console.log(`PASS S15 200-row batch in ${elapsed}ms (lease budget 600000ms)`)
  }

  // S16 future evaluation 硬闸（一审#1 验收）：拒绝、零 run、零 memory 写入
  {
    const T16 = t(16)
    const id = await ins(T16, { anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const future = new Date(Date.now() + 24 * HOUR).toISOString()
    const r = await runTransition({ tenantId: T16, scheduledFor: future })
    assert.equal(r.outcome, 'refused_future_evaluation', JSON.stringify(r))
    const runs = (await q('SELECT count(*)::INT4 AS n FROM nightly_runs WHERE tenant_id=$1', [T16])).rows[0].n
    assert.equal(runs, 0, 'zero run rows')
    const m = await row(id, T16)
    assert.equal(m.state, 'fresh'); assert.equal(Number(m.revision), 0, 'zero memory writes')
    // 显式 unsafe seam（代码内 cfg，CLI 不暴露）才放行——受控时间模拟的唯一入口
    const r2 = await runTransition({ tenantId: T16, scheduledFor: future, cfg: { ...TRANSITION_CFG, unsafe_allow_future_evaluation: true } })
    assert.equal(r2.outcome, 'completed', 'explicit unsafe seam still works for controlled simulation')
    console.log('PASS S16 future evaluation refused at the DB wall clock, seam explicit')
  }

  // S17 frozen config 越权反例（一审#4 验收）：'{}' 的 legacy run fail-closed，
  // 合法 frozen 在进程 cfg 改值后仍以 run 冻结值裁决
  {
    const T17 = t(17)
    await ins(T17, { anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = new Date().toISOString()
    const claim = await claimRun(T17, s, TRANSITION_CFG)
    assert.equal(claim.outcome, 'claimed')
    // 模拟 023 默认 '{}' 的 legacy run + lease 过期：takeover 必须 fail-closed，不得回退环境值
    await q(`UPDATE nightly_runs SET control_config='{}', lease_expires_at=now() - INTERVAL '1 minute' WHERE tenant_id=$1 AND run_id=$2`, [T17, claim.run_id])
    await assert.rejects(
      () => runTransition({ tenantId: T17, scheduledFor: s, cfg: { ...TRANSITION_CFG, max_attempts: 99 } }),
      /invalid_frozen_control_config/, 'empty frozen config must fail closed, never fall back to process cfg')
    // 恢复合法 frozen（attempt 已 1、max_attempts=1）：重启进程带 max_attempts=99 也不得续命
    await q(`UPDATE nightly_runs SET control_config='{"lease_minutes":10,"max_attempts":1,"batch_size":200}' WHERE tenant_id=$1 AND run_id=$2`, [T17, claim.run_id])
    const r = await runTransition({ tenantId: T17, scheduledFor: s, cfg: { ...TRANSITION_CFG, max_attempts: 99 } })
    assert.equal(r.outcome, 'failed_terminal', `frozen max_attempts=1 rules despite process max_attempts=99: ${JSON.stringify(r)}`)
    console.log('PASS S17 frozen control config rules takeover, empty config fails closed')
  }

  // S18 语义策略冻结（三审#1）：nightly 覆写 fade/hits/mult 一律入口拒绝——
  // 版本串的语义段永远来自冻结常数，宣称与行为同源
  {
    const T18 = t(18)
    await assert.rejects(
      () => runTransition({ tenantId: T18, scheduledFor: nowIso(), cfg: { ...TRANSITION_CFG, fade_threshold: 0.9 } }),
      /semantic_policy_override_forbidden:fade_threshold/)
    await assert.rejects(
      () => runTransition({ tenantId: T18, scheduledFor: nowIso(), cfg: { ...TRANSITION_CFG, consolidate_hits: 1 } }),
      /semantic_policy_override_forbidden:consolidate_hits/)
    const runs = (await q('SELECT count(*)::INT4 AS n FROM nightly_runs WHERE tenant_id=$1', [T18])).rows[0].n
    assert.equal(runs, 0, 'refused override leaves zero run rows')
    // batch 覆写合法（唯一每 run 可变项），版本串语义段仍为冻结常数
    assert.ok(pipelineVersionOf({ ...TRANSITION_CFG, batch_size: 7 }).includes('fade<=0.15'), 'semantic segment frozen')
    assert.ok(pipelineVersionOf({ ...TRANSITION_CFG, batch_size: 7 }).includes('batch=7'), 'batch segment effective')
    console.log('PASS S18 semantic policy override refused, batch-only variance')
  }

  // S19 各出口 control 快照（三审#2）：already_completed / failed_terminal 携带 run 行真实冻结值
  {
    const T19 = t(19)
    const id = await ins(T19, { anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = new Date().toISOString()
    const r1 = await runTransition({ tenantId: T19, scheduledFor: s })
    assert.equal(r1.outcome, 'completed')
    assert.ok(r1.control && r1.control.max_attempts === TRANSITION_CFG.max_attempts, `completed carries frozen control: ${JSON.stringify(r1.control)}`)
    const r2 = await runTransition({ tenantId: T19, scheduledFor: s, cfg: { ...TRANSITION_CFG, max_attempts: 99 } })
    assert.equal(r2.outcome, 'already_completed')
    assert.ok(r2.control && r2.control.max_attempts === TRANSITION_CFG.max_attempts, `already_completed carries the RUN's frozen control (not process cfg 99): ${JSON.stringify(r2.control)}`)
    void id
    console.log('PASS S19 every exit carries the frozen control snapshot')
  }

  console.log('ALL P0-06 TRANSITION ASSERTIONS PASSED (19 scenarios)')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    await q(`DELETE FROM nightly_runs WHERE tenant_id LIKE $1 || '%'`, [suite])
    await q(`DELETE FROM memories WHERE tenant_id LIKE $1 || '%'`, [suite])
    const E = [...eps], R = [...rids], AT = [...attempts]
    if (E.length) {
      await q('DELETE FROM success_evidence WHERE tenant_id=$1 AND experience_id IN (SELECT memory_id FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2))', [DEMO_T, E]).catch(() => {})
      await q('DELETE FROM outcomes WHERE tenant_id=$1 AND episode_id = ANY($2)', [DEMO_T, E])
      await q('DELETE FROM recall_requests WHERE tenant_id=$1 AND episode_id = ANY($2)', [DEMO_T, E])
      await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [DEMO_T, E])
    }
    if (AT.length) await q('DELETE FROM attempt_events WHERE tenant_id=$1 AND attempt_id = ANY($2)', [DEMO_T, AT])
    if (R.length) await q('DELETE FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [DEMO_T, R])
    const counts = {}
    counts.mem = (await q(`SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id LIKE $1 || '%'`, [suite])).rows[0].n
    counts.runs = (await q(`SELECT count(*)::INT4 AS n FROM nightly_runs WHERE tenant_id LIKE $1 || '%'`, [suite])).rows[0].n
    counts.demo = E.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [DEMO_T, E])).rows[0].n : 0
    const leaks = Object.entries(counts).filter(([, n]) => n !== 0)
    if (leaks.length) cleanupErrors.push(new Error('residual: ' + leaks.map(([k, n]) => `${k}=${n}`).join(' ')))
    else console.log('cleanup done (residual: all zero)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
