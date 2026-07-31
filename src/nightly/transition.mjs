// nightly transition job（P0-06，零模型调用）：领取到期行 -> revalidate -> fade/consolidate/重排。
// 契约（频道 2026-07-31 定死）：
//   - evaluation_at = scheduled_for（UTC 规范化），进 canonical fingerprint，跨 retry/takeover 固定；
//     lease/CAS 只用 DB 墙钟 now()，两钟物理分离
//   - 空 batch 直接 no-work，不落 run 行
//   - fingerprint = sha256(canonicalJson({job_kind, sources[[id,rev]], evaluation_at, pipeline_version}))
//     —— 含 evaluation time：failed run 不占下一晚的队列（次晚新 evaluation 必然新 fingerprint）
//   - fencing：expected_attempt 为 generation token，completed/stale/failed 更新 rowCount 必须 =1
//   - 整批 revision revalidate：任一 mismatch -> 整批 stale 零写入（不顺手修行）
//   - future anchor -> run failed 停机（结论 10：不 clamp）
//   - control_config 冻结进 run 行，takeover/耗尽判定只读冻结值
// 用法：node --env-file=.env src/nightly/transition.mjs --scheduled-for 2026-08-01T03:00:00Z [--tenant demo-tenant]
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inSerializableTx } from '../lib/db.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'
import { scheduleNext, consolidationProgress, TRANSITION_CFG } from '../lib/scheduler.mjs'

export const TRANSITION_PIPELINE_VERSION = [
  'transition-v1', 'sched=v1',
  `fade<=${TRANSITION_CFG.fade_threshold}`, `hits=${TRANSITION_CFG.consolidate_hits}`,
  `mult=${TRANSITION_CFG.consolidate_multiplier}`, `batch=${TRANSITION_CFG.batch_size}`,
].join('|')

const decay = (anchor, anchorAt, halfLife, evalMs) =>
  Number(anchor) * Math.exp(-Math.LN2 * ((evalMs - new Date(anchorAt).getTime()) / 3600e3) / Number(halfLife))

const SOURCE_COLS = `memory_id, revision, admission, pinned, state, layer, strength_anchor, strength_anchor_at,
  half_life_hours, credited_success_count, consolidation_baseline`

const fingerprintOf = (sources, evaluationAtIso) => createHash('sha256').update(canonicalJson({
  job_kind: 'transition',
  sources: sources.map(r => [r.memory_id, String(r.revision)]),
  evaluation_at: evaluationAtIso,
  pipeline_version: TRANSITION_PIPELINE_VERSION,
})).digest()

// claim 阶段（自己的短事务）：选源 + INSERT run。返回 null 表示 no-work。
export const claimRun = async (tenantId, evaluationAtIso, cfg) => {
  const controlConfig = { lease_minutes: cfg.lease_minutes, max_attempts: cfg.max_attempts, batch_size: cfg.batch_size }
  try {
    const claimed = await inSerializableTx(async (c) => {
      const sources = (await c.query(
        `SELECT ${SOURCE_COLS} FROM memories
         WHERE tenant_id=$1 AND next_transition_at IS NOT NULL AND next_transition_at <= $2
         ORDER BY next_transition_at, memory_id LIMIT ${cfg.batch_size}`,
        [tenantId, evaluationAtIso])).rows
      if (sources.length === 0) {
        // 空队列 != 无历史：同 scheduled_for 的既存 run（幂等重跑/failed 终态）优先于 no_work——
        // no-work 短路只适用于"这个键从未有过 run 且当下无源"
        const prior = (await c.query(
          `SELECT run_id FROM nightly_runs WHERE tenant_id=$1 AND job_kind='transition' AND scheduled_for=$2 AND pipeline_version=$3`,
          [tenantId, evaluationAtIso, TRANSITION_PIPELINE_VERSION])).rows[0]
        return prior ? { outcome: '_resolve_existing' } : { outcome: 'no_work' }
      }
      const snapshot = sources.map(r => ({ memory_id: r.memory_id, revision: String(r.revision) }))
      const run = (await c.query(
        `INSERT INTO nightly_runs (tenant_id, job_kind, scheduled_for, pipeline_version, status, lease_expires_at,
           attempt_count, batch_size, source_snapshot, source_fingerprint, control_config)
         VALUES ($1,'transition',$2,$3,'running', now() + ($4::FLOAT8 * INTERVAL '1 minute'), 1, $5, $6, $7, $8)
         RETURNING run_id`,
        [tenantId, evaluationAtIso, TRANSITION_PIPELINE_VERSION, cfg.lease_minutes, cfg.batch_size,
         JSON.stringify(snapshot), fingerprintOf(sources, evaluationAtIso), controlConfig])).rows[0]
      return { outcome: 'claimed', run_id: run.run_id, expected_attempt: 1, sources }
    }, 'transition-claim')
    // 既存 run 的分支解析在自己的事务里做（completed/failed/lease/takeover 全语义）
    return claimed.outcome === '_resolve_existing' ? resolveClaimConflict(tenantId, evaluationAtIso, cfg) : claimed
  } catch (e) {
    if (e.code !== '23505') throw e
    return resolveClaimConflict(tenantId, evaluationAtIso, cfg)
  }
}

// 23505 之后的分支（schedule-UQ 或 fingerprint-UQ，分别显式处理——不笼统吞）：
// completed -> 幂等返回；failed -> 终态返回；running 且 lease 未过期 -> lease_held；
// running lease 过期 / stale -> CAS takeover（attempt+1、重选源换 snapshot；耗尽 -> 标 failed）
const resolveClaimConflict = async (tenantId, evaluationAtIso, cfg) => {
  return inSerializableTx(async (c) => {
    const row = (await c.query(
      `SELECT run_id, status, attempt_count, lease_expires_at, control_config, lease_expires_at < now() AS lease_expired
       FROM nightly_runs WHERE tenant_id=$1 AND job_kind='transition' AND scheduled_for=$2 AND pipeline_version=$3`,
      [tenantId, evaluationAtIso, TRANSITION_PIPELINE_VERSION])).rows[0]
    if (!row) throw new Error('claim_conflict_without_schedule_row')   // fingerprint-UQ 独立撞不可能（含 evaluation_at），撞即不变量破坏
    if (row.status === 'completed') return { outcome: 'already_completed', run_id: row.run_id }
    if (row.status === 'failed') return { outcome: 'failed_terminal', run_id: row.run_id }
    // control 冻结值：takeover 判定只读 run 行，不读当前环境（023 契约）
    const frozen = { max_attempts: cfg.max_attempts, lease_minutes: cfg.lease_minutes, ...(row.control_config ?? {}) }
    if (row.status === 'running' && !row.lease_expired) return { outcome: 'lease_held', run_id: row.run_id }
    if (Number(row.attempt_count) >= Number(frozen.max_attempts)) {
      const dead = await c.query(
        `UPDATE nightly_runs SET status='failed', error_code='attempts_exhausted', updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND status IN ('running','stale') AND attempt_count=$3`,
        [tenantId, row.run_id, row.attempt_count])
      if (dead.rowCount !== 1) return { outcome: 'lease_held', run_id: row.run_id }   // 竞争者先动了
      return { outcome: 'failed_terminal', run_id: row.run_id }
    }
    // reacquire：同 run key 重选源（行可能已被写点重排），换 snapshot/fingerprint，generation+1
    const sources = (await c.query(
      `SELECT ${SOURCE_COLS} FROM memories
       WHERE tenant_id=$1 AND next_transition_at IS NOT NULL AND next_transition_at <= $2
       ORDER BY next_transition_at, memory_id LIMIT ${frozen.batch_size ?? cfg.batch_size}`,
      [tenantId, evaluationAtIso])).rows
    if (sources.length === 0) {
      const done = await c.query(
        `UPDATE nightly_runs SET status='completed', completed_at=now(), updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND status IN ('running','stale') AND attempt_count=$3`,
        [tenantId, row.run_id, row.attempt_count])
      return done.rowCount === 1 ? { outcome: 'completed', run_id: row.run_id, counts: { fade: 0, consolidate: 0, reschedule: 0 } }
                                 : { outcome: 'lease_held', run_id: row.run_id }
    }
    const snapshot = sources.map(r => ({ memory_id: r.memory_id, revision: String(r.revision) }))
    const expected = Number(row.attempt_count) + 1
    const cas = await c.query(
      `UPDATE nightly_runs SET status='running', lease_expires_at=now() + ($4::FLOAT8 * INTERVAL '1 minute'),
         attempt_count=$3, source_snapshot=$5, source_fingerprint=$6, updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND status IN ('running','stale') AND attempt_count=$7`,
      [tenantId, row.run_id, expected, frozen.lease_minutes ?? cfg.lease_minutes,
       JSON.stringify(snapshot), fingerprintOf(sources, evaluationAtIso), row.attempt_count])
    if (cas.rowCount !== 1) return { outcome: 'lease_held', run_id: row.run_id }
    return { outcome: 'claimed', run_id: row.run_id, expected_attempt: expected, sources }
  }, 'transition-conflict')
}

// execute 阶段（一个短 SERIALIZABLE 事务）：revalidate -> 三分支 set-based 批写 -> completed 同 commit
export const executeRun = async (tenantId, evaluationAtIso, run) => {
  const evalMs = new Date(evaluationAtIso).getTime()
  return inSerializableTx(async (c) => {
    const fence = { text: 'tenant_id=$1 AND run_id=$2 AND status=$3 AND attempt_count=$4', vals: [tenantId, run.run_id, 'running', run.expected_attempt] }
    const ids = run.sources.map(r => r.memory_id)
    const live = (await c.query(
      `SELECT ${SOURCE_COLS} FROM memories WHERE tenant_id=$1 AND memory_id = ANY($2)`,
      [tenantId, ids])).rows
    const liveById = new Map(live.map(r => [r.memory_id, r]))
    // 整批 revision revalidate：任何行被写点动过（或被删）-> 整批 stale 零写入
    const mismatch = run.sources.some(s => String(liveById.get(s.memory_id)?.revision) !== String(s.revision))
    if (mismatch) {
      const st = await c.query(`UPDATE nightly_runs SET status='stale', updated_at=now() WHERE ${fence.text}`, fence.vals)
      if (st.rowCount !== 1) throw new Error('fencing_violation_on_stale')
      return { outcome: 'stale', run_id: run.run_id }
    }
    // 时间不变量：future anchor -> run failed 停机（批处理无 item 级响应者）
    const future = live.filter(r => new Date(r.strength_anchor_at).getTime() > evalMs)
    if (future.length > 0) {
      const fl = await c.query(
        `UPDATE nightly_runs SET status='failed', error_code='future_anchor', error_message=$5, updated_at=now() WHERE ${fence.text}`,
        [...fence.vals, future.map(r => r.memory_id).join(',').slice(0, 900)])
      if (fl.rowCount !== 1) throw new Error('fencing_violation_on_failed')
      return { outcome: 'failed', run_id: run.run_id, reason: 'future_anchor' }
    }
    // 三分支决策（同一 evaluation 时钟；fade 胜 consolidate）
    const fades = [], consolidations = [], reschedules = []
    for (const r of live) {
      const eligible = r.admission === 'accepted' && !r.pinned && r.state !== 'faded'
      if (!eligible) { reschedules.push({ id: r.memory_id, next: scheduleNext(r, evalMs) }); continue }
      const eff = decay(r.strength_anchor, r.strength_anchor_at, r.half_life_hours, evalMs)
      if (eff <= TRANSITION_CFG.fade_threshold) { fades.push(r.memory_id); continue }
      if (r.state === 'fresh' && consolidationProgress(r) >= TRANSITION_CFG.consolidate_hits) {
        // 结论 15 铁律：先 materialize 再改 policy（乘 multiplier），衰减曲线瞬时连续
        const newHalfLife = Number(r.half_life_hours) * TRANSITION_CFG.consolidate_multiplier
        const after = { ...r, state: 'consolidated', strength_anchor: eff, strength_anchor_at: new Date(evalMs),
                        half_life_hours: newHalfLife, consolidation_baseline: r.credited_success_count }
        consolidations.push({ id: r.memory_id, anchor: eff, half_life: newHalfLife,
                              baseline: String(r.credited_success_count), next: scheduleNext(after, evalMs) })
        continue
      }
      reschedules.push({ id: r.memory_id, next: scheduleNext(r, evalMs) })
    }
    // set-based 批写（无 N+1）：fade 同步清该轮 progress（baseline=count，方案 C）
    if (fades.length) {
      await c.query(
        `UPDATE memories SET state='faded', next_transition_at=NULL, consolidation_baseline=credited_success_count,
           revision=revision+1 WHERE tenant_id=$1 AND memory_id = ANY($2)`,
        [tenantId, fades])
    }
    if (consolidations.length) {
      const vals = [], params = [tenantId, new Date(evalMs)]
      for (const x of consolidations) {
        const b = params.length
        params.push(x.id, x.anchor, x.half_life, x.baseline, x.next)
        vals.push(`($${b + 1}::UUID, $${b + 2}::FLOAT8, $${b + 3}::FLOAT8, $${b + 4}::INT8, $${b + 5}::TIMESTAMPTZ)`)
      }
      await c.query(
        `UPDATE memories AS m SET state='consolidated', strength_anchor=v.anchor, strength_anchor_at=$2,
           half_life_hours=v.hl, consolidation_baseline=v.bl, next_transition_at=v.next, revision=m.revision+1
         FROM (VALUES ${vals.join(',')}) AS v(id, anchor, hl, bl, next)
         WHERE m.tenant_id=$1 AND m.memory_id=v.id`,
        params)
    }
    if (reschedules.length) {
      const vals = [], params = [tenantId]
      for (const x of reschedules) {
        const b = params.length
        params.push(x.id, x.next)
        vals.push(`($${b + 1}::UUID, $${b + 2}::TIMESTAMPTZ)`)
      }
      await c.query(
        `UPDATE memories AS m SET next_transition_at=v.next, revision=m.revision+1
         FROM (VALUES ${vals.join(',')}) AS v(id, next)
         WHERE m.tenant_id=$1 AND m.memory_id=v.id`,
        params)
    }
    const done = await c.query(
      `UPDATE nightly_runs SET status='completed', completed_at=now(), updated_at=now() WHERE ${fence.text}`, fence.vals)
    if (done.rowCount !== 1) throw new Error('fencing_violation_on_complete')   // 旧 worker 撞上 takeover：整事务回滚
    return { outcome: 'completed', run_id: run.run_id,
             counts: { fade: fades.length, consolidate: consolidations.length, reschedule: reschedules.length } }
  }, 'transition-execute')
}

export const runTransition = async ({ tenantId, scheduledFor, cfg = TRANSITION_CFG }) => {
  const evaluationAtIso = new Date(scheduledFor).toISOString()   // UTC 规范化；即 evaluation_at
  if (Number.isNaN(new Date(evaluationAtIso).getTime())) throw new Error('scheduled_for_invalid')
  const claim = await claimRun(tenantId, evaluationAtIso, cfg)
  const result = claim.outcome === 'claimed' ? await executeRun(tenantId, evaluationAtIso, claim) : claim
  console.log(JSON.stringify({ evt: 'transition_run', tenant_id: tenantId, scheduled_for: evaluationAtIso,
    ...result, control: { lease_minutes: cfg.lease_minutes, max_attempts: cfg.max_attempts, batch_size: cfg.batch_size } }))
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let scheduledFor = null, tenantId = 'demo-tenant'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scheduled-for') scheduledFor = args[++i]
    else if (args[i] === '--tenant') tenantId = args[++i]
    else throw new Error(`unknown argument: ${args[i]}`)
  }
  if (!scheduledFor) throw new Error('--scheduled-for <ISO timestamp> is required (EventBridge canonical time)')
  const { getPool } = await import('../lib/db.mjs')
  try { await runTransition({ tenantId, scheduledFor }) } finally { await getPool().end().catch(() => {}) }
}
