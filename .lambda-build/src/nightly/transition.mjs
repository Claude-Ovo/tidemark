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
import { claimNightlyRun, FUTURE_TOLERANCE_MS as HARNESS_TOLERANCE } from './run-harness.mjs'

// pipeline_version 编码【实际生效】的参数（一审#3 + 三审#1）：语义策略（fade/hits/mult）
// 首版全局冻结——scheduler 与全部 writers 都读 TRANSITION_CFG，nightly 不许独立覆写语义
// （版本宣称与行为必须同一来源）；唯一每 run 可变的是 batch，取自实际 cfg。
// 任何语义覆写在 assertSemanticPolicyFrozen 处 fail-closed。
export const pipelineVersionOf = (cfg) => [
  'transition-v1', 'sched=v1',
  `fade<=${TRANSITION_CFG.fade_threshold}`, `hits=${TRANSITION_CFG.consolidate_hits}`,
  `mult=${TRANSITION_CFG.consolidate_multiplier}`, `batch=${cfg.batch_size}`,
].join('|')
export const TRANSITION_PIPELINE_VERSION = pipelineVersionOf(TRANSITION_CFG)

export const assertSemanticPolicyFrozen = (cfg) => {
  for (const k of ['fade_threshold', 'consolidate_hits', 'consolidate_multiplier']) {
    if (k in cfg && cfg[k] !== TRANSITION_CFG[k]) {
      throw new Error(`semantic_policy_override_forbidden:${k}`)
    }
  }
}

// 未来评估硬闸（Codex 代码一审#1，结论 10）：由 harness 统一执行，此处 re-export 保持契约可见
export const FUTURE_TOLERANCE_MS = HARNESS_TOLERANCE

const decay = (anchor, anchorAt, halfLife, evalMs) =>
  Number(anchor) * Math.exp(-Math.LN2 * ((evalMs - new Date(anchorAt).getTime()) / 3600e3) / Number(halfLife))

const SOURCE_COLS = `memory_id, revision, admission, pinned, state, layer, strength_anchor, strength_anchor_at,
  half_life_hours, credited_success_count, consolidation_baseline`

const fingerprintOf = (sources, evaluationAtIso, pipelineVersion) => createHash('sha256').update(canonicalJson({
  job_kind: 'transition',
  sources: sources.map(r => [r.memory_id, String(r.revision)]),
  evaluation_at: evaluationAtIso,
  pipeline_version: pipelineVersion,
})).digest()

// claim：委托通用 harness（src/nightly/run-harness.mjs，P0-07 抽取；行为与 P0-06 签字版逐字等价）。
// transition 特有的只有选源 SQL 与 fingerprint 素材。
const mkSelectAndSnapshot = (tenantId, cfg, pipelineVersion) => async (c, evalIso) => {
  const sources = (await c.query(
    `SELECT ${SOURCE_COLS} FROM memories
     WHERE tenant_id=$1 AND next_transition_at IS NOT NULL AND next_transition_at <= $2
     ORDER BY next_transition_at, memory_id LIMIT ${cfg.batch_size}`,
    [tenantId, evalIso])).rows
  if (sources.length === 0) return null
  return {
    sources,
    snapshot: sources.map(r => ({ memory_id: r.memory_id, revision: String(r.revision) })),
    fingerprint: fingerprintOf(sources, evalIso, pipelineVersion),
  }
}

export const claimRun = async (tenantId, evaluationAtIso, cfg) => {
  const pipelineVersion = pipelineVersionOf(cfg)
  return claimNightlyRun({
    tenantId, evaluationAtIso, jobKind: 'transition', pipelineVersion, cfg,
    selectAndSnapshot: mkSelectAndSnapshot(tenantId, cfg, pipelineVersion),
  })
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
  if (Number.isNaN(new Date(scheduledFor).getTime())) throw new Error('scheduled_for_invalid')
  assertSemanticPolicyFrozen(cfg)
  const evaluationAtIso = new Date(scheduledFor).toISOString()   // UTC 规范化；即 evaluation_at
  const claim = await claimRun(tenantId, evaluationAtIso, cfg)
  const result = claim.outcome === 'claimed' ? { ...(await executeRun(tenantId, evaluationAtIso, claim)), control: claim.control } : claim
  // control 字段 = 本 run 实际生效的冻结控制面（takeover 时为行内 frozen，绝非当前进程 cfg）
  console.log(JSON.stringify({ evt: 'transition_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...result }))
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
