// P0-06 验收：node --env-file=.env src/test-transition.mjs（S2/S3 需先起 server，EMBED_PROVIDER=stub）
// 覆盖 Codex 两轮方案审全部验收点：scheduler 纯函数/remember 一致性/写点重排/fade/consolidate 连续性/
// fade 胜 consolidate/边界零热循环/no-work 不落 run/幂等重跑/failed 次晚活性/stale reacquire/
// fencing 双提交必败/future anchor 停机/batch 有界顺延/200 行压测 vs lease
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'
import { scheduleNext, consolidationProgress, TRANSITION_CFG } from './lib/scheduler.mjs'
import { runTransition, claimRun, executeRun } from './nightly/transition.mjs'

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
const T = suite + '-tenant', A = suite + '-agent'          // 独立 tenant：nightly 是 tenant 级操作，隔离 demo 数据
const DEMO_T = 'demo-tenant'
const eps = new Set(), rids = new Set()
const ep = () => { const e = `${suite}-ep-` + randomUUID().slice(0, 6); eps.add(e); return e }
const rid = () => { const r = randomUUID(); rids.add(r); return r }
const EMB = '[' + Array(512).fill('0.01').join(',') + ']'   // accepted 行必须带 embedding（001 CHECK）
const HOUR = 3600e3
const base = Date.now()
const sched = (n) => new Date(base + n * 24 * HOUR).toISOString()   // 每场景独立"晚"，schedule-UQ 不互撞

// 直插一行（独立 tenant）：anchorAtH/nextH 为相对小时偏移（负=过去）
const ins = async ({ state = 'fresh', pinned = false, admission = 'accepted', anchor = 1.0, anchorAtH = 0,
                     halfLife = 108, count = 0, baseline = 0, nextH = null } = {}) => {
  const id = randomUUID()
  await q(
    `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, source, admission,
       state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
       credited_success_count, consolidation_baseline, next_transition_at)
     VALUES ($1,$2,$3,'event',$4,$5,$6,'agent_inferred',$7,$8,$9,0.5,$10, now()+($11::FLOAT8||' hours')::INTERVAL, now(),
       $12,$13,$14, CASE WHEN $15::FLOAT8 IS NULL THEN NULL ELSE now()+($15::FLOAT8||' hours')::INTERVAL END)`,
    [T, A, id, `${suite}-direct`, `row ${id.slice(0, 8)}`, admission === 'accepted' ? EMB : null, admission,
     state, pinned, anchor, anchorAtH, halfLife, count, baseline, nextH])
  return id
}
const row = async (id, tenant = T) => (await q(
  'SELECT state, pinned, strength_anchor, strength_anchor_at, half_life_hours, credited_success_count, consolidation_baseline, next_transition_at, revision FROM memories WHERE tenant_id=$1 AND memory_id=$2',
  [tenant, id])).rows[0]

let primaryError = null
try {
  // S1 scheduler 纯函数：全分支
  {
    const now = Date.now()
    const b = { admission: 'accepted', pinned: false, state: 'fresh', strength_anchor: 1.0,
                strength_anchor_at: new Date(now), half_life_hours: 108, credited_success_count: 0, consolidation_baseline: 0 }
    assert.equal(scheduleNext({ ...b, admission: 'quarantined' }, now), null, 'quarantined -> NULL')
    assert.equal(scheduleNext({ ...b, pinned: true }, now), null, 'pinned -> NULL')
    assert.equal(scheduleNext({ ...b, state: 'faded' }, now), null, 'faded -> NULL')
    assert.equal(scheduleNext({ ...b, credited_success_count: 3 }, now).getTime(), now, 'progress>=hits -> immediately due')
    assert.equal(scheduleNext({ ...b, credited_success_count: 5, consolidation_baseline: 3 }, now).getTime() > now, true, 'baseline eats lifetime count (progress 2 < 3)')
    assert.equal(scheduleNext({ ...b, strength_anchor: 0.15 }, now).getTime(), now, 'anchor==threshold -> due now (<= boundary)')
    const expected = now + 108 * Math.log2(1.0 / 0.15) * HOUR
    assert.ok(Math.abs(scheduleNext(b, now).getTime() - expected) < 1000, 'analytic fade crossing')
    const past = { ...b, strength_anchor_at: new Date(now - 500 * HOUR), strength_anchor: 0.5 }
    assert.ok(scheduleNext(past, now).getTime() < now, 'past crossing preserved (due semantics), not normalized to now')
    // blamed 不关唤醒的语义根基：progress 分支先于 fade crossing 判定
    assert.equal(scheduleNext({ ...b, credited_success_count: 3, strength_anchor: 0.99 }, now).getTime(), now, 'progress branch wins over crossing')
    console.log('PASS S1 scheduler pure-function branches')
  }

  // S2 remember 初始化 = 解析值（SQL 表达式与 JS scheduler 同源性）
  {
    let memId
    await withClient(async (c) => {
      const r = await call(c, 'remember', { content: 'p006 sched probe ' + suite, episode_id: ep(), request_id: rid() })
      assert.equal(r.ok, true); memId = r.memory_id
    })
    const m = await row(memId, DEMO_T)
    assert.ok(m.next_transition_at, 'remember initializes next_transition_at')
    const js = scheduleNext({ admission: 'accepted', pinned: false, state: 'fresh', strength_anchor: 1.0,
      strength_anchor_at: m.strength_anchor_at, half_life_hours: m.half_life_hours,
      credited_success_count: 0, consolidation_baseline: 0 }, new Date(m.strength_anchor_at).getTime())
    assert.ok(Math.abs(m.next_transition_at.getTime() - js.getTime()) < 2000, `SQL expr == JS scheduler (delta ${m.next_transition_at.getTime() - js.getTime()}ms)`)
    console.log('PASS S2 remember initialization matches canonical scheduler')
  }

  // S3 写点重排：pin->NULL、unpin 恢复、pinned 期攒满 progress 的 unpin 立即 due、credited 重排更晚
  {
    let memId
    await withClient(async (c) => {
      const r = await call(c, 'remember', { content: 'p006 pin resched ' + suite, episode_id: ep(), request_id: rid() })
      memId = r.memory_id
      const before = await row(memId, DEMO_T)
      assert.ok(before.next_transition_at, 'starts scheduled')
      await call(c, 'pin', { memory_id: memId, pinned: true, reason: 'unit', request_id: rid() })
      assert.equal((await row(memId, DEMO_T)).next_transition_at, null, 'pin -> NULL (leaves due queue)')
      // pinned 期间攒满 progress（直改计数模拟），unpin 必须立即 due（Codex 方案审#4）
      await q('UPDATE memories SET credited_success_count=3, consolidation_baseline=0 WHERE tenant_id=$1 AND memory_id=$2', [DEMO_T, memId])
      await call(c, 'pin', { memory_id: memId, pinned: false, reason: 'unit', request_id: rid() })
      const after = await row(memId, DEMO_T)
      assert.ok(after.next_transition_at && after.next_transition_at.getTime() <= Date.now() + 2000, 'unpin with earned progress -> immediately due')
    })
    console.log('PASS S3 write-point rescheduling (pin NULL / unpin immediate-due)')
  }

  // S4 fade 闭环：due 且衰穿 -> faded、next NULL、baseline=count（进度清零）
  {
    const id = await ins({ anchor: 0.5, anchorAtH: -200, count: 2, baseline: 0, nextH: -1 })
    const r = await runTransition({ tenantId: T, scheduledFor: sched(4) })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.counts.fade, 1, JSON.stringify(r.counts))
    const m = await row(id)
    assert.equal(m.state, 'faded')
    assert.equal(m.next_transition_at, null, 'faded leaves the queue')
    assert.equal(Number(m.consolidation_baseline), 2, 'fade resets progress (baseline=count)')
    console.log('PASS S4 fade transition + progress reset')
  }

  // S5 consolidate 闭环：materialize-then-multiply、衰减曲线瞬时连续、baseline 落袋
  {
    const id = await ins({ anchor: 1.0, anchorAtH: -10, count: 3, baseline: 0, nextH: -1 })
    const evalIso = sched(5)
    const evalMs = new Date(evalIso).getTime()
    const before = await row(id)
    const effExpected = 1.0 * Math.exp(-Math.LN2 * ((evalMs - before.strength_anchor_at.getTime()) / HOUR) / 108)
    const r = await runTransition({ tenantId: T, scheduledFor: evalIso })
    assert.equal(r.counts.consolidate, 1, JSON.stringify(r))
    const m = await row(id)
    assert.equal(m.state, 'consolidated')
    assert.equal(Number(m.half_life_hours), 108 * 3.0, 'half_life multiplied AFTER materialize')
    assert.ok(Math.abs(Number(m.strength_anchor) - effExpected) < 1e-6, `materialized anchor == effective at evaluation (curve continuity): ${m.strength_anchor} vs ${effExpected}`)
    assert.equal(m.strength_anchor_at.getTime(), evalMs, 'anchor_at re-anchored to evaluation_at')
    assert.equal(Number(m.consolidation_baseline), 3, 'baseline banked at consolidation')
    assert.ok(m.next_transition_at.getTime() > evalMs, 'rescheduled on new (slower) curve')
    console.log('PASS S5 consolidation: materialize-then-multiply, curve continuous')
  }

  // S6 fade 胜 consolidate：count 达标但已衰穿 -> faded（衰穿的行不配固化）
  {
    const id = await ins({ anchor: 0.5, anchorAtH: -200, count: 3, baseline: 0, nextH: -1 })
    const r = await runTransition({ tenantId: T, scheduledFor: sched(6) })
    assert.equal(r.counts.fade, 1)
    assert.equal(r.counts.consolidate, 0)
    const m = await row(id)
    assert.equal(m.state, 'faded', 'fade wins over consolidate')
    console.log('PASS S6 fade beats consolidate')
  }

  // S7 anchor==threshold 边界：<= 口径恰好 fade，次晚 no_work（零热循环）
  {
    const id = await ins({ anchor: 0.15, anchorAtH: 0, nextH: -1 })
    const r1 = await runTransition({ tenantId: T, scheduledFor: sched(7) })
    assert.equal(r1.counts.fade >= 1, true, 'boundary row fades under <= semantics')
    assert.equal((await row(id)).state, 'faded')
    const r2 = await runTransition({ tenantId: T, scheduledFor: sched(7.5) })
    assert.equal(r2.outcome, 'no_work', `second night must be quiet, got ${JSON.stringify(r2)}`)
    console.log('PASS S7 threshold-equality fades once, no hot loop')
  }

  // S8 no-work 不落 run 行（S7 已触发 no_work；断言零残留 run）
  {
    const n = (await q(`SELECT count(*)::INT4 AS n FROM nightly_runs WHERE tenant_id=$1 AND scheduled_for=$2`, [T, sched(7.5)])).rows[0].n
    assert.equal(n, 0, 'no_work leaves no run row')
    console.log('PASS S8 no-work writes no run row')
  }

  // S9 幂等重跑：同 scheduled_for -> already_completed、零新转换
  {
    const id = await ins({ anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = sched(9)
    const r1 = await runTransition({ tenantId: T, scheduledFor: s })
    assert.equal(r1.outcome, 'completed')
    const revAfter = Number((await row(id)).revision)
    const r2 = await runTransition({ tenantId: T, scheduledFor: s })
    assert.equal(r2.outcome, 'already_completed', JSON.stringify(r2))
    assert.equal(Number((await row(id)).revision), revAfter, 'idempotent rerun: zero re-transitions')
    console.log('PASS S9 same scheduled_for is idempotent')
  }

  // S10 failed run 不占次晚队列（fingerprint 含 evaluation_at 的活性证明）
  {
    const id = await ins({ anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = sched(10)
    await q(
      `INSERT INTO nightly_runs (tenant_id, job_kind, scheduled_for, pipeline_version, status, attempt_count, batch_size, source_snapshot, source_fingerprint, control_config, error_code)
       VALUES ($1,'transition',$2,(SELECT pipeline_version FROM nightly_runs WHERE tenant_id=$1 LIMIT 1),'failed',3,200,'[]',$3,'{}','attempts_exhausted')`,
      [T, s, Buffer.from('failed-run-fingerprint-probe-' + suite)])
    const r1 = await runTransition({ tenantId: T, scheduledFor: s })
    assert.equal(r1.outcome, 'failed_terminal', 'same night returns terminal failed')
    const r2 = await runTransition({ tenantId: T, scheduledFor: sched(10.5) })
    assert.equal(r2.outcome, 'completed', `next night reclaims the still-due sources: ${JSON.stringify(r2)}`)
    assert.equal((await row(id)).state, 'faded', 'source processed next night -- queue never wedged')
    console.log('PASS S10 failed run does not wedge the queue')
  }

  // S11 revision mismatch -> 整批 stale 零写入 -> 同 key reacquire attempt+1 -> completed
  {
    const id = await ins({ anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = sched(11)
    const claim = await claimRun(T, new Date(s).toISOString(), TRANSITION_CFG)
    assert.equal(claim.outcome, 'claimed')
    await q('UPDATE memories SET revision=revision+1 WHERE tenant_id=$1 AND memory_id=$2', [T, id])   // 写点介入
    const revBefore = Number((await row(id)).revision)
    const ex = await executeRun(T, new Date(s).toISOString(), claim)
    assert.equal(ex.outcome, 'stale', JSON.stringify(ex))
    assert.equal(Number((await row(id)).revision), revBefore, 'stale batch wrote NOTHING to memories')
    assert.equal((await row(id)).state, 'fresh', 'no transition applied by stale batch')
    const r = await runTransition({ tenantId: T, scheduledFor: s })   // reacquire 同 run key
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    const run = (await q(`SELECT attempt_count, status FROM nightly_runs WHERE tenant_id=$1 AND scheduled_for=$2 AND job_kind='transition'`, [T, s])).rows[0]
    assert.equal(run.status, 'completed')
    assert.equal(Number(run.attempt_count), 2, 'reacquire bumped generation')
    assert.equal((await row(id)).state, 'faded', 'transition applied on retry with fresh snapshot')
    console.log('PASS S11 stale batch zero-write, reacquire completes')
  }

  // S12 fencing：generation token 不符 -> 提交必败、整事务回滚
  {
    const id = await ins({ anchor: 0.5, anchorAtH: -200, nextH: -1 })
    const s = sched(12)
    const claim = await claimRun(T, new Date(s).toISOString(), TRANSITION_CFG)
    assert.equal(claim.outcome, 'claimed')
    await q(`UPDATE nightly_runs SET attempt_count=attempt_count+1 WHERE tenant_id=$1 AND run_id=$2`, [T, claim.run_id])   // 模拟 takeover
    const revBefore = Number((await row(id)).revision)
    await assert.rejects(() => executeRun(T, new Date(s).toISOString(), claim), /fencing_violation/, 'stale worker commit must fail')
    assert.equal(Number((await row(id)).revision), revBefore, 'fencing rollback: memories untouched')
    await q(`DELETE FROM nightly_runs WHERE tenant_id=$1 AND run_id=$2`, [T, claim.run_id])
    await q(`UPDATE memories SET next_transition_at=NULL, state='faded' WHERE tenant_id=$1 AND memory_id=$2`, [T, id])   // 退场
    console.log('PASS S12 lease fencing: old worker cannot double-commit')
  }

  // S13 future anchor -> run failed 停机、行零写入（结论 10）
  {
    const id = await ins({ anchor: 0.8, anchorAtH: 400, nextH: -1 })   // 锚点在 evaluation(sched 13≈312h) 之后才是 future
    const s = sched(13)
    const r = await runTransition({ tenantId: T, scheduledFor: s })
    assert.equal(r.outcome, 'failed', JSON.stringify(r))
    assert.equal(r.reason, 'future_anchor')
    const m = await row(id)
    assert.equal(m.state, 'fresh', 'contaminated row untouched (no clamp, no launder)')
    const run = (await q(`SELECT status, error_code FROM nightly_runs WHERE tenant_id=$1 AND scheduled_for=$2`, [T, s])).rows[0]
    assert.equal(run.status, 'failed'); assert.equal(run.error_code, 'future_anchor')
    await q(`UPDATE memories SET next_transition_at=NULL WHERE tenant_id=$1 AND memory_id=$2`, [T, id])   // 退场防污染后续场景
    console.log('PASS S13 future anchor fails the run closed')
  }

  // S14 batch 有界顺延：5 行 due、batch=3 -> 首晚 3 行、余 2 行次晚
  {
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(await ins({ anchor: 0.5, anchorAtH: -200, nextH: -2 + i * 0.01 }))
    const small = { ...TRANSITION_CFG, batch_size: 3 }
    const r1 = await runTransition({ tenantId: T, scheduledFor: sched(14), cfg: small })
    assert.equal(r1.counts.fade, 3, `first night bounded at 3: ${JSON.stringify(r1.counts)}`)
    const r2 = await runTransition({ tenantId: T, scheduledFor: sched(14.5), cfg: small })
    assert.equal(r2.counts.fade, 2, 'remainder rolls to next night')
    console.log('PASS S14 bounded batch defers remainder')
  }

  // S15 压测：200 行 due 一晚处理，实测时长 vs lease(10m)
  {
    await q(
      `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, source, admission,
         state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
         credited_success_count, consolidation_baseline, next_transition_at)
       SELECT $1, $2, gen_random_uuid(), 'event', $3, 'bulk ' || i, $4, 'agent_inferred', 'accepted',
         'fresh', false, 0.5, 0.5, now() - INTERVAL '200 hours', now(), 108, 0, 0, now() - INTERVAL '1 hour'
       FROM generate_series(1, 200) AS g(i)`,
      [T, A, `${suite}-bulk`, EMB])
    const t0 = Date.now()
    const r = await runTransition({ tenantId: T, scheduledFor: sched(15) })
    const elapsed = Date.now() - t0
    assert.equal(r.outcome, 'completed')
    assert.equal(r.counts.fade, 200, JSON.stringify(r.counts))
    assert.ok(elapsed < 60_000, `200-row set-based batch must be far below lease: ${elapsed}ms`)
    console.log(`PASS S15 200-row batch in ${elapsed}ms (lease budget 600000ms)`)
  }

  console.log('ALL P0-06 TRANSITION ASSERTIONS PASSED (15 scenarios)')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    await q('DELETE FROM nightly_runs WHERE tenant_id=$1', [T])
    await q('DELETE FROM memories WHERE tenant_id=$1', [T])
    const E = [...eps], R = [...rids]
    if (E.length) await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [DEMO_T, E])
    if (R.length) await q('DELETE FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [DEMO_T, R])
    const counts = {}
    counts.memories = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1', [T])).rows[0].n
    counts.runs = (await q('SELECT count(*)::INT4 AS n FROM nightly_runs WHERE tenant_id=$1', [T])).rows[0].n
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
