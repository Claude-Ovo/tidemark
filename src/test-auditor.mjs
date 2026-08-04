// P0-10 验收卷：审计账号的能与不能（验收原文："能查 receipt/attempt/pipeline；
// 所有 INSERT/UPDATE/DELETE 实测失败；不暴露原文或凭据"）。
// 前置: node --env-file=.env infra/setup-auditor.mjs --database tidemark_dev
//       （TIDEMARK_AUDITOR_PASSWORD 与本卷共用同一 env）
import './lib/test-env.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
const q = async (text, values) => auditor.query(text, values)
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

  // ---- A5+ 需要写库的红门只准 dev/disposable 库（round-3 P1-2）：prod 只跑 A1-A4 ----
  if (DB === 'tidemark_prod') {
    console.log('SKIP A5-A7 on tidemark_prod (mutation red gates are dev-only by design)')
  } else {
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

  // A6 授权漂移红门（round-3 重做：随机不可碰撞名 + CREATE 硬碰撞即停 + 清理不吞错 + 零残留后置断言）
  const { spawnSync } = await import('node:child_process')
  const rnd = randomUUID().replaceAll('-', '').slice(0, 10)
  const SCH = `drift_sch_${rnd}`, ROLE = `drift_role_${rnd}`
  await admin.query(`CREATE SCHEMA "${SCH}"`)                 // 无 IF NOT EXISTS：撞名=fail，绝不接管他人对象
  let roleCreated = false, cleanupErrors = []
  try {
    await admin.query(`CREATE TABLE "${SCH}".audit_memories (x INT)`)
    await admin.query(`GRANT USAGE ON SCHEMA "${SCH}" TO tidemark_auditor`)
    await admin.query(`GRANT SELECT ON TABLE "${SCH}".audit_memories TO tidemark_auditor`)
    await admin.query(`CREATE ROLE "${ROLE}"`)
    roleCreated = true
    await admin.query(`GRANT SELECT ON TABLE public.memories TO "${ROLE}"`)
    await admin.query(`GRANT "${ROLE}" TO tidemark_auditor`)
    await q(`SELECT count(*) FROM "${SCH}".audit_memories`)
    await q(`SELECT count(*) FROM public.memories`)
    console.log('      (drift injected and CONFIRMED effective: decoy schema + inherited role)')
    const rerun = spawnSync(process.execPath, ['--env-file=.env', 'infra/setup-auditor.mjs', '--database', DB],
      { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, TIDEMARK_AUDITOR_PASSWORD: PASSWORD } })
    assert.equal(rerun.status, 0, `A6 setup rerun failed: ${rerun.stdout}${rerun.stderr}`)
    assert.ok(rerun.stdout.includes('revoked drifted'), `A6 setup must report revocations: ${rerun.stdout}`)
    try { await q(`SELECT count(*) FROM "${SCH}".audit_memories`); assert.fail('A6 decoy grant survived') }
    catch (e) { assert.equal(e.code, '42501', `A6 decoy denial expected, got ${e.code}`) }
    try { await q(`SELECT count(*) FROM public.memories`); assert.fail('A6 inherited role read survived') }
    catch (e) { assert.equal(e.code, '42501', `A6 role-inheritance denial expected, got ${e.code}`) }
    console.log('PASS A6 drift converged: decoy-schema grant and role inheritance both revoked by rerun')
  } finally {
    // 清理顺序（round-3）：先撤 role 自身持有的授权，再删 role；任何失败进 cleanupErrors，绝不静默
    const step = async (label, sql) => { try { await admin.query(sql) } catch (e) { cleanupErrors.push(`${label}: ${e.message}`) } }
    if (roleCreated) {
      await step('revoke role table grant', `REVOKE SELECT ON TABLE public.memories FROM "${ROLE}"`)
      await step('revoke membership', `REVOKE "${ROLE}" FROM tidemark_auditor`)
      await step('drop role', `DROP ROLE "${ROLE}"`)
    }
    await step('drop decoy table', `DROP TABLE IF EXISTS "${SCH}".audit_memories`)
    await step('drop decoy schema', `DROP SCHEMA IF EXISTS "${SCH}"`)
  }
  if (cleanupErrors.length > 0) throw new Error(`A6 cleanup failures (dirty state!): ${cleanupErrors.join(' | ')}`)
  {
    const leftRole = (await admin.query(`SELECT count(*)::INT AS n FROM [SHOW ROLES] WHERE username = $1`, [ROLE])).rows[0].n
    const leftSch = (await admin.query(`SELECT count(*)::INT AS n FROM information_schema.schemata WHERE schema_name = $1`, [SCH])).rows[0].n
    assert.equal(Number(leftRole) + Number(leftSch), 0, 'A6 postcondition: zero residue (role and schema gone)')
    console.log('PASS A6-post zero residue verified')
  }

  // A6b public 扩张面 + SYSTEM 授权红门（round-3 P1-1，Codex 双注入实弹场景）
  {
    const decoy = `public_decoy_${rnd}`
    await admin.query(`CREATE TABLE public."${decoy}" (x INT)`)
    try {
      await admin.query(`GRANT SELECT ON TABLE public."${decoy}" TO public`)
      await admin.query(`GRANT SYSTEM VIEWACTIVITY TO tidemark_auditor`)
      await q(`SELECT count(*) FROM public."${decoy}"`)   // 经 public 角色继承可读——注入生效
      const sysBefore = (await admin.query(`SHOW SYSTEM GRANTS FOR tidemark_auditor`)).rows
      assert.ok(sysBefore.length > 0, 'A6b system grant injected and visible')
      console.log('      (public-role decoy + SYSTEM grant injected and CONFIRMED effective)')
      const rerun = spawnSync(process.execPath, ['--env-file=.env', 'infra/setup-auditor.mjs', '--database', DB],
        { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, TIDEMARK_AUDITOR_PASSWORD: PASSWORD } })
      assert.equal(rerun.status, 0, `A6b setup rerun failed: ${rerun.stdout}${rerun.stderr}`)
      try { await q(`SELECT count(*) FROM public."${decoy}"`); assert.fail('A6b public-role decoy grant survived') }
      catch (e) { assert.equal(e.code, '42501', `A6b decoy denial expected, got ${e.code}`) }
      const sysAfter = (await admin.query(`SHOW SYSTEM GRANTS FOR tidemark_auditor`)).rows
      assert.equal(sysAfter.length, 0, `A6b system grants must converge to zero, got ${JSON.stringify(sysAfter)}`)
      console.log('PASS A6b public-role expansion revoked and SYSTEM grants converged to zero')
    } finally {
      await admin.query(`DROP TABLE IF EXISTS public."${decoy}"`)
    }
  }

  // A7 Q3b 串线红门（round-3 P2）：两个 pair dedup 到同一 experience，judge 查询不得交叉配对
  {
    const T = 'audit-test-tenant', A = 'audit-test-agent'
    const runIds = [randomUUID(), randomUUID()]
    const expId = randomUUID()
    const mk = (i) => ({ f: `a7-f-${i}-${rnd}`, s: `a7-s-${i}-${rnd}`, fo: randomUUID(), so: randomUUID(), ev: randomUUID() })
    const P = [mk(0), mk(1)]
    const H = Buffer.from([0])
    try {
      await admin.query(`INSERT INTO memories (tenant_id, agent_id, memory_id, layer, content, embedding, embedding_model_id, experience_body, exp_status, source, admission, state, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours)
        VALUES ($1,$2,$3,'experience','a7 exp body','[${Array(512).fill('0.01').join(',')}]','stub-sha256-512','{"trigger":"t","correct_action":"a"}','candidate','derived','accepted','fresh',0.5,1.0,now(),now(),2160)`, [T, A, expId])
      for (let i = 0; i < 2; i++) {
        await admin.query(`INSERT INTO nightly_runs (tenant_id, run_id, job_kind, scheduled_for, pipeline_version, status, attempt_count, batch_size, source_fingerprint, source_snapshot, control_config)
          VALUES ($1,$2,'reflection', now() - ($3::FLOAT8 || ' hours')::INTERVAL, 'a7-test-v1', 'completed', 1, 200, $4, '{}', '{}')`, [T, runIds[i], i + 1, Buffer.from('a7fp' + i + rnd)])
        for (const [att, orid, st] of [[P[i].f, P[i].fo, 'failure'], [P[i].s, P[i].so, 'success']]) {
          await admin.query(`INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied, payload_hmac, response_json)
            VALUES ($1,$2,$3,'a7-ep','a7-task',$4,$5,'[]',false,$6,'{}')`, [T, orid, A, att, st, H])
        }
        await admin.query(`INSERT INTO attempt_events (tenant_id, agent_id, episode_id, task_instance_id, attempt_id, event_id, event_type, payload)
          VALUES ($1,$2,'a7-ep','a7-task',$3,$4,'note','{"ref":"${randomUUID()}"}')`, [T, A, P[i].f, P[i].ev])
        await admin.query(`INSERT INTO memory_event_evidence (tenant_id, derived_memory_id, attempt_id, event_id, run_id)
          VALUES ($1,$2,$3,$4,$5)`, [T, expId, P[i].f, P[i].ev, runIds[i]])
        await admin.query(`INSERT INTO reflection_pairs (tenant_id, agent_id, failure_attempt_id, success_attempt_id, failure_outcome_request_id, success_outcome_request_id, pair_fingerprint, experience_id, run_id, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'resolved')`, [T, A, P[i].f, P[i].s, P[i].fo, P[i].so, Buffer.from('a7pair' + i + rnd), expId, runIds[i]])
      }
      // doc 里的加严 Q3b（run_id + attempt 双约束）：每条 evidence 只配到自己的 pair
      const rows = (await q(`SELECT e.event_id, e.run_id, p.failure_attempt_id
        FROM memory_event_evidence e
        JOIN reflection_pairs p ON p.tenant_id = e.tenant_id AND p.experience_id = e.derived_memory_id
          AND p.run_id = e.run_id AND e.attempt_id IN (p.failure_attempt_id, p.success_attempt_id)
        WHERE e.tenant_id = $1 AND e.derived_memory_id = $2`, [T, expId])).rows
      assert.equal(rows.length, 2, `A7 exactly one pair per evidence row (no cross-pairing), got ${rows.length}`)
      for (let i = 0; i < 2; i++) {
        const r = rows.find(x => x.run_id === runIds[i])
        assert.equal(r.failure_attempt_id, P[i].f, 'A7 evidence bound to its OWN pair')
      }
      // 反证：doc 旧版（无 run/attempt 约束）确实会串成 4 行——证明加严是必要的
      const loose = (await q(`SELECT count(*)::INT AS n FROM memory_event_evidence e
        JOIN reflection_pairs p ON p.tenant_id = e.tenant_id AND p.experience_id = e.derived_memory_id
        WHERE e.tenant_id = $1 AND e.derived_memory_id = $2`, [T, expId])).rows[0].n
      assert.equal(Number(loose), 4, 'A7 the un-constrained join DOES cross-pair (4 rows) - the doc constraint is load-bearing')
      console.log('PASS A7 dedup-shared experience does not cross-pair under the judge query (loose join proven broken)')
    } finally {
      await admin.query(`DELETE FROM reflection_pairs WHERE tenant_id = $1 AND failure_attempt_id LIKE 'a7-f-%'`, [T])
      await admin.query(`DELETE FROM memory_event_evidence WHERE tenant_id = $1 AND derived_memory_id = $2`, [T, expId])
      await admin.query(`DELETE FROM attempt_events WHERE tenant_id = $1 AND episode_id = 'a7-ep'`, [T])
      await admin.query(`DELETE FROM outcomes WHERE tenant_id = $1 AND episode_id = 'a7-ep'`, [T])
      await admin.query(`DELETE FROM nightly_runs WHERE tenant_id = $1 AND pipeline_version = 'a7-test-v1'`, [T])
      await admin.query(`DELETE FROM memories WHERE tenant_id = $1 AND memory_id = $2`, [T, expId])
    }
  }
  await admin.end()
  }

  console.log(DB === 'tidemark_prod' ? 'ALL P0-10 AUDITOR ASSERTIONS PASSED (A1-A4, prod read-only mode)' : 'ALL P0-10 AUDITOR ASSERTIONS PASSED (A1-A7)')
} finally { await auditor.end() }
