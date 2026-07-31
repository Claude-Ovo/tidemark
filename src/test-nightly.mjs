// P0-07 验收：node --env-file=.env src/test-nightly.mjs（纯直插+直调，无需 server）
// 单文件承载 dream(D)/reflection(R)/orchestrator(N) 三段——共享 fixture 基建，
// npm run test:dream / test:reflection / test:nightly 均指向本套件。
// 打击点全覆盖：高价值/derived/NULL-episode 不入梦、截断稳定、第 2 簇失败整批零写、
// 跨 agent 不串、配对窗口跨夜、exactly-once 跨晚、anchors 优先截断（failure 淹没 success）、
// input_too_large 持久跳过、同批 dedup agent 分区、无 attempt_end 的 outcome provenance、
// 异指纹竞态 stale、dream stale 短路 transition、reflection 不阻 transition。
import { assertStubLocked } from './lib/test-env.mjs'   // 必须第一个 import：无条件锁 stub
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'
import { embed } from './lib/embed.mjs'
import { toVectorLiteral } from './lib/vector-canonical.mjs'
import { runDream, DREAM_CFG, claimDream, executeDream } from './nightly/dream.mjs'
import { runReflection, REFLECT_CFG, claimReflection, executeReflection } from './nightly/reflection.mjs'
import { runTransition } from './nightly/transition.mjs'
import { runNightly } from './nightly/orchestrator.mjs'
import { claimRun } from './nightly/transition.mjs'
import { TRANSITION_CFG } from './lib/scheduler.mjs'

let forensic = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try { forensic ??= await connectWithRetry(cs, { label: 'forensic' }); return await forensic.query(text, params) }
    catch (e) { await forensic?.end().catch(() => {}); forensic = null; if (!isRetryableDatabaseError(e) || attempt >= 5) throw e; await sleep(800 * attempt) }
  }
}
const suite = 'p007-' + randomUUID().slice(0, 8)
const t = (n) => `${suite}-t${n}`
const nowIso = () => new Date().toISOString()
const HOUR = 3600e3

// dream 素材：due 低权重 event 行（默认可入梦）
const insMem = async (tenant, agent, episode, content, over = {}) => {
  const o = { importance: 0.3, credited: 0, source: 'agent_inferred', state: 'fresh', pinned: false,
              layer: 'event', nextH: -1, createdOffH: 0, ...over }
  const id = randomUUID()
  const e = await embed(content)
  await q(
    `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, source, admission,
       state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
       credited_success_count, consolidation_baseline, next_transition_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'accepted',$9,$10,$11,0.5, now() - INTERVAL '200 hours', now(), 108,
       $12, 0, CASE WHEN $13::FLOAT8 IS NULL THEN NULL ELSE now()+($13::FLOAT8||' hours')::INTERVAL END,
       now()+($14::FLOAT8||' hours')::INTERVAL)`,
    [tenant, agent, id, o.layer, episode, content, e.f32 ? toVectorLiteral(e.f32) : null, o.source,
     o.state, o.pinned, o.importance, o.credited, o.nextH, o.createdOffH])
  return id
}
// reflection 素材：failure/success outcome 对（可带事件）
const insEvent = async (tenant, agent, episode, task, att, type, payload, offH) => {
  const id = randomUUID()
  await q(
    `INSERT INTO attempt_events (tenant_id, agent_id, episode_id, task_instance_id, attempt_id, event_id, event_type, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()+($9::FLOAT8||' hours')::INTERVAL)`,
    [tenant, agent, episode, task, att, id, type, payload, offH])
  return id
}
const insOutcome = async (tenant, agent, episode, task, att, status, offH) => {
  const orid = randomUUID()
  await q(
    `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied, payload_hmac, response_json, reported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'[]',false,$8,'{}', now()+($9::FLOAT8||' hours')::INTERVAL)`,
    [tenant, orid, agent, episode, task, att, status, Buffer.from('t-hmac'), offH])
  return orid
}
const mkPair = async (tenant, agent, { episode, task, failOffH = -2, succOffH = -1, withEvents = true } = {}) => {
  const ep = episode ?? `${suite}-ep-` + randomUUID().slice(0, 6)
  const tk = task ?? `${suite}-task-` + randomUUID().slice(0, 6)
  const attF = 'f-' + randomUUID().slice(0, 8), attS = 's-' + randomUUID().slice(0, 8)
  if (withEvents) {
    await insEvent(tenant, agent, ep, tk, attF, 'tool_error', { error_type: 'timeout', args_digest: 'a'.repeat(64) }, failOffH - 0.1)
    await insEvent(tenant, agent, ep, tk, attS, 'note', { ref: randomUUID() }, succOffH - 0.1)
  }
  await insOutcome(tenant, agent, ep, tk, attF, 'failure', failOffH)
  await insOutcome(tenant, agent, ep, tk, attS, 'success', succOffH)
  return { episode: ep, task: tk, attF, attS }
}
const mems = async (tenant, where = '', params = []) =>
  (await q(`SELECT * FROM memories WHERE tenant_id=$1 ${where}`, [tenant, ...params])).rows

let primaryError = null
try {
  await assertStubLocked()   // 二审#3：加载后断言 provider 导出确为 stub
  // ===== D1 选源边界：高价值/derived/NULL episode/pinned/不足 min_cluster 全不入梦 =====
  {
    const T = t('d1'), A = T + '-a', EP = T + '-ep'
    await insMem(T, A, EP, 'd1 frag 1'); await insMem(T, A, EP, 'd1 frag 2')          // 只有 2 条：不成簇
    await insMem(T, A, EP, 'd1 valuable', { importance: 0.8 })                          // 高 importance
    await insMem(T, A, EP, 'd1 credited', { credited: 2 })                              // 有战功
    await insMem(T, A, EP, 'd1 derived', { source: 'derived' })                         // 梦中梦拒
    await insMem(T, A, null, 'd1 no episode')                                           // NULL episode
    const r = await runDream({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'no_work', `nothing clusters: ${JSON.stringify(r)}`)
    console.log('PASS D1 selection excludes valuable/credited/derived/NULL-episode; min_cluster holds')
  }

  // ===== D2+D3 截断稳定 + 完整产物：10 条同簇取最旧 8，余 2 留给 transition =====
  {
    const T = t('d2'), A = T + '-a', EP = T + '-ep'
    const ids = []
    for (let i = 0; i < 10; i++) ids.push(await insMem(T, A, EP, `d2 frag ${i}`, { createdOffH: -10 + i }))
    const r = await runDream({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.counts.clusters, 1)
    assert.equal(r.counts.sources_faded, 8, 'oldest 8 taken')
    const faded = await mems(T, `AND state='faded'`)
    assert.deepEqual(faded.map(m => m.memory_id).sort(), ids.slice(0, 8).sort(), 'exactly the 8 oldest faded')
    for (const f of faded) assert.equal(Number(f.consolidation_baseline), Number(f.credited_success_count), 'fade banks baseline')
    const derived = (await mems(T, `AND source='derived'`))[0]
    assert.ok(derived, 'derived memory exists')
    assert.ok(derived.content.includes('[salient]'), 'salient_points rendered into content')
    assert.equal(derived.episode_id, EP); assert.equal(derived.agent_id, A)
    const edges = (await q('SELECT count(*)::INT4 AS n FROM memory_derivations WHERE tenant_id=$1 AND derived_memory_id=$2', [T, derived.memory_id])).rows[0].n
    assert.equal(edges, 8, 'one provenance edge per source')
    const rr = (await q(`SELECT result_receipt FROM nightly_runs WHERE tenant_id=$1 AND job_kind='dream'`, [T])).rows[0].result_receipt
    assert.equal(rr.clusters.length, 1)
    assert.equal(rr.clusters[0].derived_memory_id, derived.memory_id)
    assert.ok(rr.clusters[0].output_checksum && rr.clusters[0].time_range.from <= rr.clusters[0].time_range.to, 'receipt carries checksum + server time_range')
    // 余 2 行仍 due：transition 收尾
    const tr = await runTransition({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(tr.counts.fade, 2, 'remainder handled by transition')
    console.log('PASS D2+D3 stable truncation, full product, remainder to transition')
  }

  // ===== D4 幂等重跑 =====
  {
    const T = t('d4'), A = T + '-a', EP = T + '-ep'
    for (let i = 0; i < 3; i++) await insMem(T, A, EP, `d4 frag ${i}`)
    const s = nowIso()
    assert.equal((await runDream({ tenantId: T, scheduledFor: s })).outcome, 'completed')
    const n1 = (await mems(T, `AND source='derived'`)).length
    const r2 = await runDream({ tenantId: T, scheduledFor: s })
    assert.equal(r2.outcome, 'already_completed', JSON.stringify(r2))
    assert.equal((await mems(T, `AND source='derived'`)).length, n1, 'zero duplicate products')
    console.log('PASS D4 same scheduled_for idempotent')
  }

  // ===== D5 第 2 簇失败整批零写（admission 拒发生在任一簇 => 零产物零 fade） =====
  {
    const T = t('d5'), A = T + '-a'
    for (let i = 0; i < 3; i++) await insMem(T, A, T + '-ep1', `d5 clean ${i}`)
    // 第二簇带 AWS key 模式：stub summary 拼接正文 -> admission gate 拒 -> terminal
    for (let i = 0; i < 3; i++) await insMem(T, A, T + '-ep2', `d5 dirty AKIAABCDEFGHIJKLMNOP ${i}`)
    const r = await runDream({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'failed', JSON.stringify(r))
    assert.equal((await mems(T, `AND source='derived'`)).length, 0, 'zero products')
    assert.equal((await mems(T, `AND state='faded'`)).length, 0, 'zero fades — all-or-nothing')
    const run = (await q(`SELECT status, error_code FROM nightly_runs WHERE tenant_id=$1`, [T])).rows[0]
    assert.equal(run.status, 'failed')
    console.log('PASS D5 second-cluster rejection => whole batch zero-write')
  }

  // ===== D6 跨 agent 同名 episode 不串 =====
  {
    const T = t('d6'), EP = T + '-shared-ep'
    for (let i = 0; i < 3; i++) await insMem(T, T + '-agentA', EP, `d6 a ${i}`)
    for (let i = 0; i < 3; i++) await insMem(T, T + '-agentB', EP, `d6 b ${i}`)
    const r = await runDream({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.counts.clusters, 2, 'same episode string, two agents => two clusters')
    const derived = await mems(T, `AND source='derived'`)
    assert.equal(derived.length, 2)
    assert.notEqual(derived[0].agent_id, derived[1].agent_id, 'products stay agent-scoped')
    for (const d of derived) {
      const srcs = (await q(`SELECT m.agent_id FROM memory_derivations md JOIN memories m ON m.tenant_id=md.tenant_id AND m.memory_id=md.source_memory_id WHERE md.tenant_id=$1 AND md.derived_memory_id=$2`, [T, d.memory_id])).rows
      assert.ok(srcs.every(s => s.agent_id === d.agent_id), 'no cross-agent provenance edge')
    }
    console.log('PASS D6 cross-agent same-name episodes never mix')
  }

  // ===== D7 真实 revalidate：claim 后写点介入 => 整批 stale 零写 => reacquire 完成 =====
  {
    const T = t('d7'), A = T + '-a', EP = T + '-ep'
    const ids = []
    for (let i = 0; i < 3; i++) ids.push(await insMem(T, A, EP, `d7 frag ${i}`))
    const s7 = new Date().toISOString()
    const claim = await claimDream(T, s7, DREAM_CFG)
    assert.equal(claim.outcome, 'claimed', JSON.stringify(claim))
    await q('UPDATE memories SET revision=revision+1 WHERE tenant_id=$1 AND memory_id=$2', [T, ids[0]])
    const ex = await executeDream(T, s7, claim)
    assert.equal(ex.outcome, 'stale', JSON.stringify(ex))
    assert.equal((await mems(T, `AND source='derived'`)).length, 0, 'stale batch: zero products')
    assert.equal((await mems(T, `AND state='faded'`)).length, 0, 'stale batch: zero fades')
    const r = await runDream({ tenantId: T, scheduledFor: s7 })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal((await mems(T, `AND source='derived'`)).length, 1, 'reacquire with fresh snapshot completes')
    console.log('PASS D7 dream revalidate: stale zero-write, reacquire completes')
  }

  // ===== R1 配对正确性：最早 success 胜出，episode 不一致不配 =====
  {
    const T = t('r1'), A = T + '-a', EP = T + '-ep', TK = T + '-task'
    const attF = 'f-' + randomUUID().slice(0, 8)
    await insEvent(T, A, EP, TK, attF, 'tool_error', { error_type: 'timeout', args_digest: 'a'.repeat(64) }, -3.1)
    await insOutcome(T, A, EP, TK, attF, 'failure', -3)
    const attS1 = 's1-' + randomUUID().slice(0, 8), attS2 = 's2-' + randomUUID().slice(0, 8)
    await insOutcome(T, A, EP, TK, attS1, 'success', -2)     // 更早：应胜
    await insOutcome(T, A, EP, TK, attS2, 'success', -1)
    await insOutcome(T, A, T + '-other-ep', TK, 'sx-' + randomUUID().slice(0, 8), 'success', -2.5)   // episode 不一致：不配
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    const lg = (await q('SELECT success_attempt_id FROM reflection_pairs WHERE tenant_id=$1', [T])).rows
    assert.equal(lg.length, 1)
    assert.equal(lg[0].success_attempt_id, attS1, 'EARLIEST same-episode success wins')
    console.log('PASS R1 pairing picks earliest success, episode must match')
  }

  // ===== R2 窗口跨夜边界：fail=t-73h, success=t-2h（差 71h 合法），评估=now 仍配上 =====
  {
    const T = t('r2'), A = T + '-a'
    await mkPair(T, A, { failOffH: -73, succOffH: -2 })
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.counts.pairs, 1, 'legal 71h pair not lost to pickup delay (retention 120h)')
    console.log('PASS R2 cross-night boundary pair survives')
  }

  // ===== R3 exactly-once 跨晚 =====
  {
    const T = t('r3'), A = T + '-a'
    await mkPair(T, A, {})
    assert.equal((await runReflection({ tenantId: T, scheduledFor: nowIso() })).outcome, 'completed')
    const n1 = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND layer=\'experience\'', [T])).rows[0].n
    // cursor 语义：第二晚=越过 consumed 行的推进 run（0 对零产物），第三晚 cursor 已过=真 no_work
    const r2 = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r2.counts?.pairs ?? 0, 0, `consumed pair yields zero pairs: ${JSON.stringify(r2)}`)
    assert.equal((await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND layer=\'experience\'', [T])).rows[0].n, n1)
    const r3 = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r3.outcome, 'no_work', `cursor passed: third night is quiet: ${JSON.stringify(r3)}`)
    console.log('PASS R3 pair consumed exactly once across nights (cursor advances past it)')
  }

  // ===== R4 anchors 优先截断：failure 侧 40 条事件淹没，success terminal 仍在证据里 =====
  {
    const T = t('r4'), A = T + '-a', EP = T + '-ep', TK = T + '-task'
    const attF = 'f-' + randomUUID().slice(0, 8), attS = 's-' + randomUUID().slice(0, 8)
    const errId = await insEvent(T, A, EP, TK, attF, 'tool_error', { error_type: 'timeout', args_digest: 'a'.repeat(64) }, -3.5)
    for (let i = 0; i < 40; i++) await insEvent(T, A, EP, TK, attF, 'note', { ref: randomUUID() }, -3.4 + i * 0.01)
    const termId = await insEvent(T, A, EP, TK, attS, 'note', { ref: randomUUID() }, -1.5)
    await insOutcome(T, A, EP, TK, attF, 'failure', -3)
    await insOutcome(T, A, EP, TK, attS, 'success', -1)
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    const evid = (await q('SELECT event_id FROM memory_event_evidence WHERE tenant_id=$1', [T])).rows.map(x => x.event_id)
    assert.ok(evid.includes(errId), 'failure error anchor present')
    assert.ok(evid.includes(termId), 'success terminal anchor NOT drowned by 40 failure notes')
    console.log('PASS R4 anchors survive failure-side flood')
  }

  // ===== R5 input_too_large 持久跳过：不占额度、跨晚不回 =====
  {
    const T = t('r5'), A = T + '-a', EP = T + '-ep', TK = T + '-task'
    const attF = 'f-' + randomUUID().slice(0, 8), attS = 's-' + randomUUID().slice(0, 8)
    // 33 条必需 anchors（tool_error）> 32 上限 => input_too_large
    for (let i = 0; i < 33; i++) await insEvent(T, A, EP, TK, attF, 'tool_error', { error_type: 'timeout', args_digest: 'b'.repeat(64) }, -3.5 + i * 0.001)
    await insOutcome(T, A, EP, TK, attF, 'failure', -3)
    await insOutcome(T, A, EP, TK, attS, 'success', -1)
    await mkPair(T, A, {})   // 一对正常 pair 证明额度不被 skip 吃掉
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.counts.pairs, 1); assert.equal(r.counts.skipped, 1)
    const lg = (await q('SELECT status, experience_id FROM reflection_pairs WHERE tenant_id=$1 ORDER BY status', [T])).rows
    assert.equal(lg.length, 2)
    const skip = lg.find(x => x.status === 'skipped_input_too_large')
    assert.ok(skip && skip.experience_id === null, 'durable skip decision with NULL experience')
    const r2 = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r2.outcome, 'no_work', 'skipped pair never re-enters')
    console.log('PASS R5 oversized pair terminally skipped, quota unaffected')
  }

  // ===== R6 同批 dedup：同 agent 合并、跨 agent 各自成物 =====
  {
    const T = t('r6'), A1 = T + '-a1', A2 = T + '-a2'
    const EP = T + '-ep', TK = T + '-task'
    // 同 task 同 episode 两对（时间错开保证各配各的 success）：stub 叙述同文 => 应合并
    await mkPair(T, A1, { episode: EP, task: TK, failOffH: -4, succOffH: -3.5 })
    await mkPair(T, A1, { episode: EP, task: TK, failOffH: -2, succOffH: -1 })
    await mkPair(T, A2, { episode: EP, task: TK, failOffH: -4, succOffH: -3.5 })   // 跨 agent 同文 => 不合并
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    const exps = (await q(`SELECT agent_id FROM memories WHERE tenant_id=$1 AND layer='experience'`, [T])).rows
    const a1n = exps.filter(x => x.agent_id === A1).length
    const a2n = exps.filter(x => x.agent_id === A2).length
    assert.equal(a2n, 1, 'cross-agent twin gets its own experience')
    assert.ok(a1n >= 1 && r.counts.dedup_batch >= 1, `same-agent twins merged (a1=${a1n}, batch=${r.counts.dedup_batch})`)
    const lg = (await q('SELECT experience_id, agent_id FROM reflection_pairs WHERE tenant_id=$1 AND status=\'resolved\'', [T])).rows
    for (const row of lg) {
      const exp = (await q('SELECT agent_id FROM memories WHERE tenant_id=$1 AND memory_id=$2', [T, row.experience_id])).rows[0]
      assert.equal(exp.agent_id, row.agent_id, 'ledger never points across agents')
    }
    console.log('PASS R6 batch dedup merges within agent, never across')
  }

  // ===== R7 server 封口 + 无 attempt_end 的 provenance =====
  {
    const T = t('r7'), A = T + '-a'
    const p = await mkPair(T, A, { withEvents: false })   // success attempt 零事件
    await insEvent(T, A, p.episode, p.task, p.attF, 'tool_error', { error_type: 'timeout', args_digest: 'c'.repeat(64) }, -2.1)
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    const exp = (await q(`SELECT experience_body FROM memories WHERE tenant_id=$1 AND layer='experience'`, [T])).rows[0]
    const anchors = (await q('SELECT event_id FROM memory_event_evidence WHERE tenant_id=$1', [T])).rows.map(x => x.event_id).sort()
    assert.deepEqual([...exp.experience_body.evidence_ids].sort(), anchors, 'evidence_ids server-written == evidence edges (model never invents)')
    assert.equal(exp.experience_body.scope, 'task')
    const lg = (await q('SELECT failure_outcome_request_id, success_outcome_request_id FROM reflection_pairs WHERE tenant_id=$1', [T])).rows[0]
    assert.ok(lg.failure_outcome_request_id && lg.success_outcome_request_id, 'terminal truth anchored to outcomes without any attempt_end event')
    console.log('PASS R7 server-sealed evidence, outcome-anchored provenance sans attempt_end')
  }

  // ===== R8 真实 ledger race：claim 后另一 run 抢占同 pair（异指纹）=> 整批 stale 零副作用 =====
  {
    const T = t('r8'), A = T + '-a'
    const p8 = await mkPair(T, A, {})
    const s8 = new Date().toISOString()
    const claim = await claimReflection(T, s8, REFLECT_CFG)
    assert.equal(claim.outcome, 'claimed', JSON.stringify(claim))
    const runFx = randomUUID()
    await q(`INSERT INTO nightly_runs (tenant_id, run_id, job_kind, scheduled_for, pipeline_version, status, attempt_count, batch_size, source_snapshot, source_fingerprint, control_config)
             VALUES ($1,$2,'reflection', now() - INTERVAL '1 day', 'fx', 'completed', 1, 1, '[]', $3, '{}')`,
      [T, runFx, Buffer.from('fx-' + suite)])
    await q(`INSERT INTO reflection_pairs (tenant_id, agent_id, failure_attempt_id, success_attempt_id, failure_outcome_request_id, success_outcome_request_id, pair_fingerprint, experience_id, run_id, status)
             SELECT $1, $2, $3, $4, o1.outcome_request_id, o2.outcome_request_id, $5, NULL, $6, 'skipped_input_too_large'
             FROM (SELECT outcome_request_id FROM outcomes WHERE tenant_id=$1 AND attempt_id=$3) o1,
                  (SELECT outcome_request_id FROM outcomes WHERE tenant_id=$1 AND attempt_id=$4) o2`,
      [T, A, p8.attF, p8.attS, Buffer.from('divergent-fingerprint-' + suite), runFx])
    const ex = await executeReflection(T, s8, claim)
    assert.equal(ex.outcome, 'stale', `divergent-fingerprint conflict must stale the batch: ${JSON.stringify(ex)}`)
    assert.equal((await q(`SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND layer='experience'`, [T])).rows[0].n, 0, 'zero side effects')
    console.log('PASS R8 real ledger race: divergent fingerprint stales the batch, zero writes')
  }

  // ===== R9 二审#1 组合：DB 既有 candidate + 同批双胞胎 => 全链指向 DB winner E =====
  {
    const T = t('r9'), A = T + '-a', EP = T + '-ep', TK = T + '-task'
    await mkPair(T, A, { episode: EP, task: TK, failOffH: -30, succOffH: -29 })
    const r0 = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r0.outcome, 'completed')
    const E = (await q(`SELECT memory_id FROM memories WHERE tenant_id=$1 AND layer='experience'`, [T])).rows[0].memory_id
    await mkPair(T, A, { episode: EP, task: TK, failOffH: -4, succOffH: -3.5 })
    await mkPair(T, A, { episode: EP, task: TK, failOffH: -2, succOffH: -1 })
    const r1 = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r1.outcome, 'completed', JSON.stringify(r1))
    assert.ok(r1.counts.dedup_db >= 1 && r1.counts.dedup_batch >= 1, `both dedup layers fired: ${JSON.stringify(r1.counts)}`)
    assert.equal(r1.counts.inserted, 0, 'no new experience — everything resolves to E')
    const expN = (await q(`SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND layer='experience'`, [T])).rows[0].n
    assert.equal(expN, 1, 'still exactly one experience (E)')
    const ledger = (await q(`SELECT experience_id FROM reflection_pairs WHERE tenant_id=$1 AND status='resolved'`, [T])).rows
    assert.equal(ledger.length, 3)
    assert.ok(ledger.every(x => x.experience_id === E), 'ledger rows ALL point at E')
    const evid = (await q(`SELECT DISTINCT derived_memory_id FROM memory_event_evidence WHERE tenant_id=$1`, [T])).rows
    assert.deepEqual(evid.map(x => x.derived_memory_id), [E], 'evidence edges ALL point at E — no dangling generated ids')
    console.log('PASS R9 DB-candidate + batch-twin combo all resolves to E (the 23503 counterexample)')
  }

  // ===== R10 饥饿根治（cursor 语义）：201 个过窗 failure 压阵，推进速率 200/晚，
  // 合法 pair 最迟第二晚配上——keyset progress 的 SLA 实证 =====
  {
    const T = t('r10'), A = T + '-a'
    await q(
      `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied, payload_hmac, response_json, reported_at)
       SELECT $1, gen_random_uuid()::STRING, $2, 'ep-starve', 'task-starve-' || i, 'att-starve-' || i, 'failure', '[]', false, $3, '{}',
              now() - INTERVAL '100 hours' + (i || ' seconds')::INTERVAL
       FROM generate_series(1, 201) AS g(i)`,
      [T, A, Buffer.from('starve')])
    await mkPair(T, A, { failOffH: -2, succOffH: -1 })
    const r1 = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r1.outcome, 'completed', JSON.stringify(r1))
    const night1pairs = r1.counts.pairs
    const r2 = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    const total = night1pairs + (r2.counts?.pairs ?? 0)
    assert.equal(total, 1, `legal pair found within two nights (cursor rate 200/night): n1=${night1pairs} n2=${JSON.stringify(r2.counts)}`)
    const lg = (await q(`SELECT count(*)::INT4 AS n FROM reflection_pairs WHERE tenant_id=$1 AND status='resolved'`, [T])).rows[0].n
    assert.equal(lg, 1, 'exactly one resolved ledger row')
    console.log('PASS R10 201 expired failures cannot starve a legal pair (bounded cursor progress)')
  }

  // ===== R11 二审#4 envelope 边界：巨型 task 字符串把真实输入推过 16KiB => input_too_large =====
  {
    const T = t('r11'), A = T + '-a'
    const bigTask = 'task-' + 'x'.repeat(17000)
    await mkPair(T, A, { task: bigTask })
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.counts.skipped, 1, `oversized ENVELOPE (not just payload) must skip: ${JSON.stringify(r.counts)}`)
    assert.equal(r.counts.pairs, 0)
    console.log('PASS R11 envelope bytes govern the real model input, task strings included')
  }

  // ===== N1 dream 占源：schedule 键被 running dream 占住 => 整体短路，transition 零抢占 =====
  {
    const T = t('n1'), A = T + '-a', EP = T + '-ep'
    for (let i = 0; i < 3; i++) await insMem(T, A, EP, `n1 frag ${i}`)
    const s = new Date().toISOString()
    // 预放 running 未过期 dream run 占住 (tenant, dream, s, version)
    const { dreamPipelineVersionOf, DREAM_CFG: DC } = await import('./nightly/dream.mjs')
    await q(`INSERT INTO nightly_runs (tenant_id, run_id, job_kind, scheduled_for, pipeline_version, status, lease_expires_at, attempt_count, batch_size, source_snapshot, source_fingerprint, control_config)
             VALUES ($1,$2,'dream',$3,$4,'running', now() + INTERVAL '9 minutes', 1, 200, '[]', $5, '{"lease_minutes":10,"max_attempts":3,"batch_size":200}')`,
      [T, randomUUID(), s, dreamPipelineVersionOf(DC), Buffer.from('n1-' + suite)])
    const r = await runNightly({ tenantId: T, scheduledFor: s })
    assert.equal(r.outcome, 'short_circuited_at_dream', JSON.stringify(r.outcome))
    assert.equal((await mems(T, `AND state='faded'`)).length, 0, 'transition never ran — zero preemptive fades')
    console.log('PASS N1 running dream short-circuits the whole night')
  }

  // ===== N2 reflection 被占不阻 transition（degraded 语义的核心） =====
  {
    const T = t('n2'), A = T + '-a', EP = T + '-ep'
    const id = await insMem(T, A, EP, 'n2 lone due row', { importance: 0.8 })   // 高价值：dream 不碰，transition fade
    const s = new Date().toISOString()
    const { reflectPipelineVersionOf, REFLECT_CFG: RC } = await import('./nightly/reflection.mjs')
    await q(`INSERT INTO nightly_runs (tenant_id, run_id, job_kind, scheduled_for, pipeline_version, status, lease_expires_at, attempt_count, batch_size, source_snapshot, source_fingerprint, control_config)
             VALUES ($1,$2,'reflection',$3,$4,'running', now() + INTERVAL '9 minutes', 1, 200, '[]', $5, '{"lease_minutes":10,"max_attempts":3,"batch_size":200}')`,
      [T, randomUUID(), s, reflectPipelineVersionOf(RC), Buffer.from('n2-' + suite)])
    const r = await runNightly({ tenantId: T, scheduledFor: s })
    assert.equal(r.reflection.outcome, 'lease_held', JSON.stringify(r.reflection))
    assert.equal(r.transition.outcome, 'completed', `reflection blockage must NOT starve transition: ${JSON.stringify(r.transition)}`)
    assert.equal((await mems(T, `AND memory_id='${id}'`))[0].state, 'faded', 'lifecycle proceeded')
    console.log('PASS N2 reflection blockage never starves deterministic lifecycle')
  }

  // ===== N3 全链 completed（正式化 smoke） =====
  {
    const T = t('n3'), A = T + '-a', EP = T + '-ep'
    for (let i = 0; i < 3; i++) await insMem(T, A, EP, `n3 frag ${i}`)
    await mkPair(T, A, {})
    const r = await runNightly({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r.outcome))
    assert.equal(r.dream.outcome, 'completed'); assert.equal(r.reflection.outcome, 'completed')
    console.log('PASS N3 full-chain nightly completes')
  }

  // ===== N4 reflection 异常隔离（round-3 #3）：throw 也不得阻断 transition =====
  {
    const T = t('n4'), A = T + '-a', EP = T + '-ep'
    const id = await insMem(T, A, EP, 'n4 lone due row', { importance: 0.8 })
    const r = await runNightly({ tenantId: T, scheduledFor: nowIso(),
      _jobs: { runReflection: async () => { throw new Error('provider exploded mid-flight') } } })
    assert.equal(r.reflection.outcome, 'crashed', JSON.stringify(r.reflection))
    assert.ok(r.reflection.error.includes('exploded'), 'exception honestly structured')
    assert.equal(r.transition.outcome, 'completed', `transition ran despite reflection THROW: ${JSON.stringify(r.transition)}`)
    assert.equal((await mems(T, `AND memory_id='${id}'`))[0].state, 'faded', 'lifecycle proceeded')
    console.log('PASS N4 reflection exception cannot block the deterministic lifecycle')
  }

  // ===== R12 cursor 单调不变量（round-5 #1）：双 claim 反序提交，cursor 永不后退 =====
  {
    const T = t('r12'), A = T + '-a'
    // 两条已过窗 failure（无 success）：F1 更早、F2 更晚
    await q(
      `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied, payload_hmac, response_json, reported_at)
       SELECT $1, 'r12-f' || i, $2, 'ep', 'task-' || i, 'att-' || i, 'failure', '[]', false, $3, '{}',
              now() - INTERVAL '100 hours' + (i || ' hours')::INTERVAL
       FROM generate_series(1, 2) AS g(i)`,
      [T, A, Buffer.from('h')])
    const sEarly = new Date(Date.now() - 60_000).toISOString()   // A：较早 evaluation（相对窗口只判到 F1..F2 同样过窗——两 run 都可推进）
    const sLate = new Date().toISOString()
    const claimA = await claimReflection(T, sEarly, REFLECT_CFG)
    assert.equal(claimA.outcome, 'claimed', JSON.stringify(claimA))
    const claimB = await claimReflection(T, sLate, REFLECT_CFG)
    assert.equal(claimB.outcome, 'claimed', JSON.stringify(claimB))
    // 反序提交：B（更晚、推进更远）先 commit，A 后 commit——cursor 必须停在 max
    const exB = await executeReflection(T, sLate, claimB)
    assert.equal(exB.outcome, 'completed', JSON.stringify(exB))
    const curAfterB = (await q('SELECT last_outcome_request_id FROM reflection_cursor WHERE tenant_id=$1', [T])).rows[0].last_outcome_request_id
    const exA = await executeReflection(T, sEarly, claimA)
    assert.equal(exA.outcome, 'completed', JSON.stringify(exA))
    const curAfterA = (await q('SELECT last_outcome_request_id FROM reflection_cursor WHERE tenant_id=$1', [T])).rows[0].last_outcome_request_id
    assert.equal(curAfterA, curAfterB, `cursor NEVER regresses on out-of-order commit: afterB=${curAfterB} afterA=${curAfterA}`)
    assert.equal(curAfterA, 'r12-f2', 'cursor rests at the max tuple')
    console.log('PASS R12 out-of-order commits cannot regress the cursor')
  }

  // ===== R13 首次 seed 跳过 pre-migration 积压（round-5 #2）：300 条窗外历史 + 当前合法 pair 首跑当晚配上 =====
  {
    const T = t('r13'), A = T + '-a'
    await q(
      `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied, payload_hmac, response_json, reported_at)
       SELECT $1, gen_random_uuid()::STRING, $2, 'ep-backlog', 'task-b-' || i, 'att-b-' || i, 'failure', '[]', false, $3, '{}',
              now() - INTERVAL '2000 hours' + (i || ' minutes')::INTERVAL
       FROM generate_series(1, 300) AS g(i)`,
      [T, A, Buffer.from('backlog')])
    await mkPair(T, A, { failOffH: -2, succOffH: -1 })
    const r = await runReflection({ tenantId: T, scheduledFor: nowIso() })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.counts.pairs, 1, `first run seeds past 300-row backlog and pairs on NIGHT ONE: ${JSON.stringify(r.counts)}`)
    console.log('PASS R13 initial cursor seed skips pre-migration backlog entirely')
  }

  // ===== N4b unclassified 异常真实分阶段（round-5 #5 尾款）：run 落 retryable 可 takeover =====
  {
    const T = t('n4b'), A = T + '-a'
    await mkPair(T, A, {})
    const s4 = new Date().toISOString()
    const claim = await claimReflection(T, s4, REFLECT_CFG)
    assert.equal(claim.outcome, 'claimed')
    claim.sources[0].envelope = null   // 污染 claim：JSON.parse(null) 前 provider 收 null -> unclassified throw
    await assert.rejects(() => executeReflection(T, s4, claim), /./, 'unclassified path throws')
    const run = (await q(`SELECT status, error_code, lease_expires_at < now() AS expired FROM nightly_runs WHERE tenant_id=$1 AND run_id=$2`, [T, claim.run_id])).rows[0]
    assert.equal(run.status, 'running', 'run stays running but...')
    assert.equal(run.error_code, 'unclassified_error')
    assert.equal(run.expired, true, '...lease already expired: takeover-ready, never hung')
    const retry = await runReflection({ tenantId: T, scheduledFor: s4 })   // takeover 收尾
    assert.equal(retry.outcome, 'completed', `takeover completes the run: ${JSON.stringify(retry)}`)
    console.log('PASS N4b unclassified exception leaves the run takeover-ready, retry completes')
  }

  console.log('ALL P0-07 NIGHTLY ASSERTIONS PASSED (D1-D7 R1-R13 N1-N4b)')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    for (const tbl of ['reflection_cursor', 'reflection_pairs', 'memory_event_evidence', 'memory_derivations', 'nightly_runs', 'outcomes', 'attempt_events', 'memories']) {
      await q(`DELETE FROM ${tbl} WHERE tenant_id LIKE $1 || '%'`, [suite])
    }
    const counts = {}
    for (const tbl of ['memories', 'nightly_runs', 'reflection_pairs', 'reflection_cursor', 'outcomes']) {
      counts[tbl] = (await q(`SELECT count(*)::INT4 AS n FROM ${tbl} WHERE tenant_id LIKE $1 || '%'`, [suite])).rows[0].n
    }
    const leaks = Object.entries(counts).filter(([, n]) => n !== 0)
    if (leaks.length) cleanupErrors.push(new Error('residual: ' + leaks.map(([k, n]) => `${k}=${n}`).join(' ')))
    else console.log('cleanup done (residual: all zero)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
