// nightly run 通用骨架（P0-07 抽取自已签字的 transition 实现，行为逐字保留）：
// claim / conflict 状态机（completed 幂等 / failed 终态 / lease held / 过期或 stale 的
// CAS takeover，attempt=generation token）/ 未来评估硬闸 / no-work 不落 run /
// frozen control fail-closed / fencing 模板。job 特有的选源、snapshot、fingerprint、
// execute 语义由调用方注入。
// 失败分类（P0-07 方案二审#5）：transient（provider/网络/embedding 瞬断）不首错终态——
// 标记 lease 立即过期保持同 snapshot 可 takeover，attempt 耗尽才 failed；
// schema/admission/invariant 为 terminal，直接 failed。
import { inSerializableTx } from '../lib/db.mjs'

export const FUTURE_TOLERANCE_MS = 5 * 60_000

const isPosInt = (v) => Number.isInteger(v) && v > 0
const isPosFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

// claim：选源 + INSERT run（同一短事务）。selectAndSnapshot(c, evalIso) 返回
// { sources, snapshot, fingerprint } 或 null（无源）。
export const claimNightlyRun = async ({ tenantId, evaluationAtIso, jobKind, pipelineVersion, cfg, selectAndSnapshot }) => {
  const controlConfig = { lease_minutes: cfg.lease_minutes, max_attempts: cfg.max_attempts, batch_size: cfg.batch_size }
  try {
    const claimed = await inSerializableTx(async (c) => {
      const dbNow = (await c.query('SELECT now() AS db_now')).rows[0].db_now.getTime()
      if (!cfg.unsafe_allow_future_evaluation && new Date(evaluationAtIso).getTime() > dbNow + FUTURE_TOLERANCE_MS) {
        return { outcome: 'refused_future_evaluation', db_now: new Date(dbNow).toISOString() }
      }
      const picked = await selectAndSnapshot(c, evaluationAtIso)
      if (!picked) {
        const prior = (await c.query(
          `SELECT run_id FROM nightly_runs WHERE tenant_id=$1 AND job_kind=$2 AND scheduled_for=$3 AND pipeline_version=$4`,
          [tenantId, jobKind, evaluationAtIso, pipelineVersion])).rows[0]
        return prior ? { outcome: '_resolve_existing' } : { outcome: 'no_work' }
      }
      const run = (await c.query(
        `INSERT INTO nightly_runs (tenant_id, job_kind, scheduled_for, pipeline_version, status, lease_expires_at,
           attempt_count, batch_size, source_snapshot, source_fingerprint, control_config)
         VALUES ($1,$2,$3,$4,'running', now() + ($5::FLOAT8 * INTERVAL '1 minute'), 1, $6, $7, $8, $9)
         RETURNING run_id`,
        [tenantId, jobKind, evaluationAtIso, pipelineVersion, cfg.lease_minutes, cfg.batch_size,
         JSON.stringify(picked.snapshot), picked.fingerprint, controlConfig])).rows[0]
      return { outcome: 'claimed', run_id: run.run_id, expected_attempt: 1, sources: picked.sources, control: controlConfig }
    }, `${jobKind}-claim`)
    return claimed.outcome === '_resolve_existing'
      ? resolveNightlyConflict({ tenantId, evaluationAtIso, jobKind, pipelineVersion, cfg, selectAndSnapshot })
      : claimed
  } catch (e) {
    if (e.code !== '23505') throw e
    return resolveNightlyConflict({ tenantId, evaluationAtIso, jobKind, pipelineVersion, cfg, selectAndSnapshot })
  }
}

const resolveNightlyConflict = async ({ tenantId, evaluationAtIso, jobKind, pipelineVersion, cfg, selectAndSnapshot }) => {
  return inSerializableTx(async (c) => {
    const row = (await c.query(
      `SELECT run_id, status, attempt_count, lease_expires_at, control_config, lease_expires_at < now() AS lease_expired
       FROM nightly_runs WHERE tenant_id=$1 AND job_kind=$2 AND scheduled_for=$3 AND pipeline_version=$4`,
      [tenantId, jobKind, evaluationAtIso, pipelineVersion])).rows[0]
    if (!row) throw new Error('claim_conflict_without_schedule_row')
    const rawControl = row.control_config ?? null
    if (row.status === 'completed') return { outcome: 'already_completed', run_id: row.run_id, control: rawControl }
    if (row.status === 'failed') return { outcome: 'failed_terminal', run_id: row.run_id, control: rawControl }
    const frozen = rawControl
    if (!frozen || !isPosInt(frozen.max_attempts) || !isPosFinite(frozen.lease_minutes) || !isPosInt(frozen.batch_size)) {
      throw new Error(`invalid_frozen_control_config:${row.run_id}`)
    }
    if (row.status === 'running' && !row.lease_expired) return { outcome: 'lease_held', run_id: row.run_id, control: frozen }
    if (Number(row.attempt_count) >= Number(frozen.max_attempts)) {
      const dead = await c.query(
        `UPDATE nightly_runs SET status='failed', error_code='attempts_exhausted', updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND status IN ('running','stale') AND attempt_count=$3`,
        [tenantId, row.run_id, row.attempt_count])
      if (dead.rowCount !== 1) return { outcome: 'lease_held', run_id: row.run_id, control: frozen }
      return { outcome: 'failed_terminal', run_id: row.run_id, control: frozen }
    }
    const picked = await selectAndSnapshot(c, evaluationAtIso)
    if (!picked) {
      const done = await c.query(
        `UPDATE nightly_runs SET status='completed', completed_at=now(), updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND status IN ('running','stale') AND attempt_count=$3`,
        [tenantId, row.run_id, row.attempt_count])
      return done.rowCount === 1
        ? { outcome: 'completed', run_id: row.run_id, counts: {}, control: frozen }
        : { outcome: 'lease_held', run_id: row.run_id, control: frozen }
    }
    const expected = Number(row.attempt_count) + 1
    const cas = await c.query(
      `UPDATE nightly_runs SET status='running', lease_expires_at=now() + ($4::FLOAT8 * INTERVAL '1 minute'),
         attempt_count=$3, source_snapshot=$5, source_fingerprint=$6, updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND status IN ('running','stale') AND attempt_count=$7`,
      [tenantId, row.run_id, expected, frozen.lease_minutes, JSON.stringify(picked.snapshot), picked.fingerprint, row.attempt_count])
    if (cas.rowCount !== 1) return { outcome: 'lease_held', run_id: row.run_id, control: frozen }
    return { outcome: 'claimed', run_id: row.run_id, expected_attempt: expected, sources: picked.sources, control: frozen }
  }, `${jobKind}-conflict`)
}

// fencing 模板：run 终态更新必须命中恰一行（generation token），否则整事务回滚
export const fenceUpdate = async (c, { tenantId, runId, expectedAttempt }, setSql, extraVals = []) => {
  const upd = await c.query(
    `UPDATE nightly_runs SET ${setSql}, updated_at=now()
     WHERE tenant_id=$1 AND run_id=$2 AND status='running' AND attempt_count=$3`,
    [tenantId, runId, expectedAttempt, ...extraVals])
  if (upd.rowCount !== 1) throw new Error('fencing_violation')
  return upd
}

// transient 失败恢复：保持同 snapshot/fingerprint，立即过期 lease 使下次调用可 takeover；
// attempt 不在此加（takeover 时才 +1）。terminal 失败走 fenceUpdate status='failed'。
export const markRetryable = async ({ tenantId, runId, expectedAttempt, errorCode }) => {
  return inSerializableTx(async (c) => {
    const upd = await c.query(
      `UPDATE nightly_runs SET lease_expires_at=now() - INTERVAL '1 second', error_code=$4, updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2 AND status='running' AND attempt_count=$3`,
      [tenantId, runId, expectedAttempt, errorCode])
    return { retryable: upd.rowCount === 1 }
  }, 'mark-retryable')
}
