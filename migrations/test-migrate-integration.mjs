// 真实升级序列回归（Codex P0-05 round-4 #3）：走真实 applyOne（含 preflight 时序），
// 专用一次性库 tidemark_mig_test，全程与 dev 库无交集。
// 剧本：001-013 -> 植入 legacy outcome（证据只在 tool_requests）-> 标准续跑必须在
// 014 前 fail-closed 且两侧证据完好 -> 人工 backfill（preflight 指引原文）-> 重跑全通、
// 副本被 014 清、017 NOT NULL 成立。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connectWithRetry, quoteIdentifier, validateDatabaseName, withDatabase } from './db.mjs'
import { loadMigrations, ensureMigrationLedger, applyOne } from './apply.mjs'

const DB = validateDatabaseName('tidemark_mig_test')
const base = process.env.COCKROACH_DATABASE_URL
if (!base) throw new Error('missing COCKROACH_DATABASE_URL')

const admin = await connectWithRetry(base, { label: 'admin' })
await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(DB)} CASCADE`)
await admin.query(`CREATE DATABASE ${quoteIdentifier(DB)}`)
await admin.end().catch(() => {})

const client = await connectWithRetry(withDatabase(base, DB), { label: DB })
try {
  const migrations = await loadMigrations()
  await ensureMigrationLedger(client)

  // 1) 推进到 013（含）——"013 刚加完 nullable 列"的真实升级中间态
  for (const m of migrations.filter(m => m.version <= 13)) {
    assert.equal(await applyOne(client, m), 'applied', m.filename)
  }

  // 2) 植入 legacy：旧实现的 outcome 行（证据列 NULL）+ 唯一幂等证据在 tool_requests
  //    （012 的 CHECK 此刻允许 report_outcome，015 尚未应用——正是历史现场）
  const T = 'mig-test-tenant', A = 'mig-test-agent', ORID = randomUUID()
  const HMAC = Buffer.from('legacy-hmac-32-bytes-suite-probe')
  const RESP = { ok: true, outcome_request_id: ORID, items: [] }
  await client.query(
    `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied)
     VALUES ($1,$2,$3,'ep','task','att-legacy','cancelled','[]',false)`, [T, ORID, A])
  await client.query(
    `INSERT INTO tool_requests (tenant_id, agent_id, tool_name, request_id, payload_hmac, response_json)
     VALUES ($1,$2,'report_outcome',$3,$4,$5)`, [T, A, ORID, HMAC, RESP])

  // 3) 标准续跑：必须在 014 preflight 上拒，最早破坏点之前
  await assert.rejects(
    async () => { for (const m of migrations.filter(m => m.version >= 14)) await applyOne(client, m) },
    (e) => e.message.includes('PREFLIGHT 014 REFUSED') && e.message.includes('BACKFILL'),
    'standard migrate must refuse at 014, before the earliest destruction point')

  // 4) 两侧证据完好，014+ 均未入台账
  const o1 = (await client.query('SELECT payload_hmac FROM outcomes WHERE tenant_id=$1 AND outcome_request_id=$2', [T, ORID])).rows[0]
  assert.ok(o1, 'outcome row intact'); assert.equal(o1.payload_hmac, null, 'still unfilled (nothing half-done)')
  const t1 = (await client.query(`SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND tool_name='report_outcome'`, [T])).rows[0].n
  assert.equal(t1, 1, 'tool_requests evidence intact')
  const led = (await client.query('SELECT count(*)::INT4 AS n FROM schema_migrations WHERE version >= 14')).rows[0].n
  assert.equal(led, 0, 'no 014+ ledger entries')
  console.log('PASS 1 standard migrate refuses at 014; evidence intact on both sides')

  // 5) 人工恢复 = preflight 014 指引的 backfill 原文
  await client.query(
    `UPDATE outcomes o SET payload_hmac = tr.payload_hmac, response_json = tr.response_json
     FROM tool_requests tr
     WHERE tr.tenant_id = o.tenant_id AND tr.agent_id = o.agent_id AND tr.tool_name = 'report_outcome'
       AND tr.request_id = o.outcome_request_id AND (o.payload_hmac IS NULL OR o.response_json IS NULL)`)

  // 6) 重跑全通；7) 终态：证据入 outcomes、副本被 014 清、台账齐
  for (const m of migrations.filter(m => m.version >= 14)) {
    assert.equal(await applyOne(client, m), 'applied', m.filename)
  }
  const o2 = (await client.query('SELECT payload_hmac, response_json FROM outcomes WHERE tenant_id=$1 AND outcome_request_id=$2', [T, ORID])).rows[0]
  assert.ok(o2.payload_hmac.equals(HMAC), 'evidence backfilled into outcomes verbatim')
  assert.equal(o2.response_json.ok, true, 'first response preserved for exact replay')
  const t2 = (await client.query(`SELECT count(*)::INT4 AS n FROM tool_requests WHERE tool_name='report_outcome'`)).rows[0].n
  assert.equal(t2, 0, '014 removed the now-redundant copies')
  const total = (await client.query('SELECT count(*)::INT4 AS n FROM schema_migrations')).rows[0].n
  assert.equal(total, migrations.length, 'ledger complete after recovery')
  console.log('PASS 2 backfill -> full migrate green; evidence lives in outcomes, copies cleaned')

  console.log('ALL MIGRATE INTEGRATION TESTS PASSED')
} finally {
  await client.end().catch(() => {})
  const admin2 = await connectWithRetry(base, { label: 'admin-cleanup' })
  await admin2.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(DB)} CASCADE`).catch(() => {})
  await admin2.end().catch(() => {})
}
