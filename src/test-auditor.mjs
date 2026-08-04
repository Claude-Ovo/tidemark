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

  // A4 视图列安全：任何视图不得暴露原文/向量/预览/自由错误文本列
  const banned = new Set(['content', 'embedding', 'experience_body', 'query_preview', 'error_message'])
  const cols = (await q(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('audit_memories','audit_recalls','audit_nightly_runs')`)).rows
  for (const { table_name, column_name } of cols) {
    assert.ok(!banned.has(column_name), `A4 ${table_name} leaks banned column ${column_name}`)
  }
  assert.ok(cols.some(c => c.column_name === 'has_content'), 'A4 presence markers exist')
  console.log('PASS A4 no prose/vector/preview/free-text column crosses the view boundary')

  console.log('ALL P0-10 AUDITOR ASSERTIONS PASSED (A1-A4)')
} finally { await auditor.end() }
