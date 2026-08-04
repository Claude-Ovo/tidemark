// P0-10 验收卷：审计账号的能与不能（验收原文："能查 receipt/attempt/pipeline；
// 所有 INSERT/UPDATE/DELETE 实测失败；不暴露原文或凭据"）。
// 前置: node --env-file=.env infra/setup-auditor.mjs --database tidemark_dev
//       （TIDEMARK_AUDITOR_PASSWORD 与本卷共用同一 env）
import './lib/test-env.mjs'
import assert from 'node:assert/strict'
import pg from 'pg'
import { withDatabase } from '../migrations/db.mjs'
import { AUDIT_RELATIONS } from '../infra/setup-auditor.mjs'

const PASSWORD = process.env.TIDEMARK_AUDITOR_PASSWORD
assert.ok(PASSWORD, 'TIDEMARK_AUDITOR_PASSWORD required (same value passed to setup-auditor)')
const DB = process.env.TIDEMARK_DATABASE || 'tidemark_dev'

// 把连接串的身份换成 auditor（保留主机/端口/TLS 参数）
const u = new URL(withDatabase(process.env.COCKROACH_DATABASE_URL, DB))
u.username = 'tidemark_auditor'
u.password = PASSWORD
const auditor = new pg.Pool({ connectionString: u.href, max: 2 })
const q = async (text) => auditor.query(text)
const expectDenied = async (label, text) => {
  try { await q(text); assert.fail(`${label}: expected permission denial, got success`) }
  catch (e) {
    assert.ok(e.code === '42501', `${label}: expected 42501, got ${e.code} (${e.message?.slice(0, 80)})`)
  }
}

try {
  // A1 授权面全部可读（receipt/attempt/pipeline 三链都在其中）
  for (const rel of AUDIT_RELATIONS) {
    const r = await q(`SELECT count(*)::INT AS n FROM public."${rel}"`)
    assert.ok(Number.isInteger(Number(r.rows[0].n)), `A1 ${rel} readable`)
  }
  console.log(`PASS A1 all ${AUDIT_RELATIONS.length} audit relations readable (receipts, attempts, pipeline runs)`)

  // A2 原文承载基表：无授权，读即拒
  for (const base of ['memories', 'recall_requests', 'nightly_runs']) {
    await expectDenied(`A2 ${base}`, `SELECT count(*) FROM public.${base}`)
  }
  console.log('PASS A2 prose-bearing base tables are invisible to the auditor')

  // A3 写操作全线拒绝（视图与表、三种动词）
  await expectDenied('A3 insert view', `INSERT INTO public.audit_memories (tenant_id) VALUES ('x')`)
  await expectDenied('A3 insert table', `INSERT INTO public.attempt_events (tenant_id, agent_id, episode_id, task_instance_id, attempt_id, event_id, event_type) VALUES ('x','x','x','x','x', gen_random_uuid(), 'note')`)
  await expectDenied('A3 update', `UPDATE public.outcomes SET status = 'failure' WHERE tenant_id = 'x'`)
  await expectDenied('A3 delete', `DELETE FROM public.memory_tombstones WHERE tenant_id = 'x'`)
  await expectDenied('A3 ddl', `CREATE TABLE public.sneaky (x INT)`)
  console.log('PASS A3 every write verb denied (insert/update/delete/ddl)')

  // A4（round-2 加严）：全部 12 个授权 relation 的【精确列面】冻结对表——
  // 任何新增/改名/漏遮列都在这里爆，不再只查五个禁列名
  const EXPECTED_SURFACE = {
    audit_memories: ['admission', 'agent_id', 'consolidation_baseline', 'content_length', 'created_at', 'credited_success_count', 'embedding_model_id', 'episode_id', 'evidenced_blame_count', 'exp_status', 'half_life_hours', 'has_content', 'has_embedding', 'has_experience_body', 'importance', 'kind', 'last_rewarded_at', 'layer', 'memory_id', 'next_transition_at', 'pinned', 'quarantine_expires_at', 'revision', 'source', 'state', 'strength_anchor', 'strength_anchor_at', 'tenant_id'],
    audit_recalls: ['agent_id', 'attempt_id', 'created_at', 'episode_id', 'expires_at', 'outcome_state', 'pipeline_version', 'preview_enabled', 'query_hmac', 'receipt_json', 'request_id', 'serialization_checksum', 'tenant_id', 'terminal_attempt_id'],
    audit_nightly_runs: ['attempt_count', 'batch_size', 'completed_at', 'control_config', 'error_code', 'has_error_message', 'job_kind', 'lease_expires_at', 'model_id', 'pipeline_version', 'result_receipt', 'run_id', 'scheduled_for', 'source_fingerprint', 'source_snapshot', 'started_at', 'status', 'tenant_id', 'updated_at'],
    audit_memory_rebuild_queue: ['agent_id', 'attempt_count', 'completed_at', 'created_at', 'deleted_derived_memory_id', 'has_last_error', 'lease_expires_at', 'originating_run_id', 'rebuild_id', 'remaining_source_memory_ids', 'status', 'tenant_id', 'updated_at'],
    attempt_events: ['agent_id', 'attempt_id', 'created_at', 'episode_id', 'event_id', 'event_type', 'payload', 'task_instance_id', 'tenant_id', 'tool_name'],
    outcomes: ['agent_id', 'attempt_id', 'attributions', 'episode_id', 'outcome_request_id', 'payload_hmac', 'plasticity_applied', 'reported_at', 'response_json', 'status', 'task_instance_id', 'tenant_id'],
    memory_derivations: ['created_at', 'derived_memory_id', 'run_id', 'source_memory_id', 'tenant_id'],
    memory_event_evidence: ['attempt_id', 'created_at', 'derived_memory_id', 'event_id', 'run_id', 'tenant_id'],
    reflection_pairs: ['agent_id', 'created_at', 'experience_id', 'failure_attempt_id', 'failure_outcome_request_id', 'pair_fingerprint', 'run_id', 'status', 'success_attempt_id', 'success_outcome_request_id', 'tenant_id'],
    memory_tombstones: ['deleted_at', 'memory_id', 'reason', 'tenant_id'],
    success_evidence: ['created_at', 'experience_id', 'outcome_request_id', 'task_instance_id', 'tenant_id'],
    reflection_cursor: ['last_outcome_request_id', 'last_reported_at', 'tenant_id', 'updated_at'],
  }
  const surf = (await q(`SELECT table_name, array_agg(column_name ORDER BY column_name) AS cols
    FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[${AUDIT_RELATIONS.map(r => `'${r}'`).join(',')}]) GROUP BY table_name`)).rows
  assert.equal(surf.length, AUDIT_RELATIONS.length, 'A4 every allowlisted relation visible in information_schema')
  for (const { table_name, cols } of surf) {
    assert.deepEqual(cols, EXPECTED_SURFACE[table_name], `A4 exact column surface of ${table_name}`)
  }
  console.log(`PASS A4 exact column surface frozen for all ${AUDIT_RELATIONS.length} relations`)

  // A5 自由文本 sentinel 红门（round-2 P1-1）：admin 往 rebuild_queue.last_error 写哨兵，
  // auditor 无论投影原列（42703：视图上根本没有）还是任何可读面都摸不到它
  const admin = new pg.Pool({ connectionString: withDatabase(process.env.COCKROACH_DATABASE_URL, DB), max: 1 })
  const SENTINEL = 'SENTINEL-' + Math.random().toString(36).slice(2, 10)
  const rbId = (await admin.query(
    `INSERT INTO memory_rebuild_queue (tenant_id, agent_id, deleted_derived_memory_id, remaining_source_memory_ids, status, last_error)
     VALUES ('audit-test-tenant', 'audit-test-agent', gen_random_uuid(), ARRAY[]::UUID[], 'abandoned', $1) RETURNING rebuild_id`, [SENTINEL])).rows[0].rebuild_id
  try {
    try { await q(`SELECT last_error FROM public.audit_memory_rebuild_queue`); assert.fail('A5 last_error must not exist on the view') }
    catch (e) { assert.equal(e.code, '42703', `A5 undefined column expected, got ${e.code}`) }
    const flag = (await q(`SELECT has_last_error FROM public.audit_memory_rebuild_queue WHERE tenant_id = 'audit-test-tenant'`)).rows[0]
    assert.equal(flag.has_last_error, true, 'A5 presence flag visible')
    try { await q(`SELECT last_error FROM public.memory_rebuild_queue`); assert.fail('A5 base table must be invisible') }
    catch (e) { assert.equal(e.code, '42501', `A5 base denial expected, got ${e.code}`) }
    console.log('PASS A5 free-text sentinel unreachable (view lacks the column, base table denied)')
  } finally {
    await admin.query(`DELETE FROM memory_rebuild_queue WHERE rebuild_id = $1`, [rbId])
  }

  // A6 授权漂移红门（round-2 P1-2）：他 schema 同名表 + 角色继承注入，setup 重跑必须精确复原
  const { spawnSync } = await import('node:child_process')
  await admin.query(`CREATE SCHEMA IF NOT EXISTS secretsch`)
  await admin.query(`CREATE TABLE IF NOT EXISTS secretsch.audit_memories (x INT)`)
  await admin.query(`GRANT USAGE ON SCHEMA secretsch TO tidemark_auditor`)
  await admin.query(`GRANT SELECT ON TABLE secretsch.audit_memories TO tidemark_auditor`)
  await admin.query(`CREATE ROLE IF NOT EXISTS snooprole`)
  await admin.query(`GRANT SELECT ON TABLE public.memories TO snooprole`)
  await admin.query(`GRANT snooprole TO tidemark_auditor`)
  try {
    // 注入生效的证明（不然红门测了个寂寞）
    await q(`SELECT count(*) FROM secretsch.audit_memories`)
    await q(`SELECT count(*) FROM public.memories`)
    console.log('      (drift injected and CONFIRMED effective: decoy schema + inherited role)')
    const rerun = spawnSync(process.execPath, ['--env-file=.env', 'infra/setup-auditor.mjs', '--database', DB],
      { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, TIDEMARK_AUDITOR_PASSWORD: PASSWORD } })
    assert.equal(rerun.status, 0, `A6 setup rerun failed: ${rerun.stdout}${rerun.stderr}`)
    assert.ok(rerun.stdout.includes('revoked drifted'), `A6 setup must report revocations: ${rerun.stdout}`)
    try { await q(`SELECT count(*) FROM secretsch.audit_memories`); assert.fail('A6 decoy grant survived') }
    catch (e) { assert.equal(e.code, '42501', `A6 decoy denial expected, got ${e.code}`) }
    try { await q(`SELECT count(*) FROM public.memories`); assert.fail('A6 inherited role read survived') }
    catch (e) { assert.equal(e.code, '42501', `A6 role-inheritance denial expected, got ${e.code}`) }
    console.log('PASS A6 drift converged: decoy-schema grant and role inheritance both revoked by rerun')
  } finally {
    await admin.query(`REVOKE snooprole FROM tidemark_auditor`).catch(() => {})
    await admin.query(`DROP ROLE IF EXISTS snooprole`).catch(() => {})
    await admin.query(`DROP TABLE IF EXISTS secretsch.audit_memories`).catch(() => {})
    await admin.query(`DROP SCHEMA IF EXISTS secretsch`).catch(() => {})
    await admin.end()
  }

  console.log('ALL P0-10 AUDITOR ASSERTIONS PASSED (A1-A6)')
} finally { await auditor.end() }
