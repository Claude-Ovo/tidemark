// 真实升级序列回归（Codex P0-05 round-4 #3 + round-5 harness 返工）：走真实 applyOne
// （含 preflight 时序），每幕一个唯一随机一次性库——CREATE 不带 IF NOT EXISTS（撞名
// fail-closed，绝不 DROP 任何预先存在的库），只清理本次确认创建成功的库。
// Act 1（backfill 支路）：001-013 -> 植入 legacy outcome（证据在 tool_requests）->
//   标准续跑必须在 014 前拒且两侧证据完好 -> backfill -> 全通、副本被 014 清。
// Act 2（marker 支路，README 恢复手册的另一半）：001-015 -> 植入证据已丢的 NULL 行 ->
//   016 必须拒且指引 marker -> 执行 README marker SQL 原文 -> 016-019 全通 ->
//   marker 行存续（0x00 单字节 + unreplayable 标记），017 NOT NULL 成立。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connectWithRetry, validateDatabaseName } from './db.mjs'
import { loadMigrations, ensureMigrationLedger, applyOne } from './apply.mjs'
import { withDisposableDb } from './disposable-db.mjs'

const base = process.env.COCKROACH_DATABASE_URL
if (!base) throw new Error('missing COCKROACH_DATABASE_URL')

const mkDbName = () =>
  validateDatabaseName(`tidemark_mig_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`)

// 生命周期封装在 disposable-db.mjs（CREATE/connect/fn 同一最外层 try——round-6 反例修复），
// 其"connect 失败仍精确清理"行为由 src/test-disposable-db.mjs 以注入 fake 单测锁定
const disposable = (fn) => withDisposableDb({ base, mkName: mkDbName, connect: connectWithRetry, fn })

const T = 'mig-test-tenant', A = 'mig-test-agent'

// ===== Act 1: 停在 013 + 证据尚在 -> 014 前拒 -> backfill -> 全通 =====
await disposable(async (client) => {
  const migrations = await loadMigrations()
  await ensureMigrationLedger(client)
  for (const m of migrations.filter(m => m.version <= 13)) {
    assert.equal(await applyOne(client, m), 'applied', m.filename)
  }

  const ORID = randomUUID()
  const HMAC = Buffer.from('legacy-hmac-32-bytes-suite-probe')
  const RESP = { ok: true, outcome_request_id: ORID, items: [] }
  await client.query(
    `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied)
     VALUES ($1,$2,$3,'ep','task','att-legacy','cancelled','[]',false)`, [T, ORID, A])
  await client.query(
    `INSERT INTO tool_requests (tenant_id, agent_id, tool_name, request_id, payload_hmac, response_json)
     VALUES ($1,$2,'report_outcome',$3,$4,$5)`, [T, A, ORID, HMAC, RESP])

  await assert.rejects(
    async () => { for (const m of migrations.filter(m => m.version >= 14)) await applyOne(client, m) },
    (e) => e.message.includes('PREFLIGHT 014 REFUSED') && e.message.includes('BACKFILL'),
    'standard migrate must refuse at 014, before the earliest destruction point')

  const o1 = (await client.query('SELECT payload_hmac FROM outcomes WHERE tenant_id=$1 AND outcome_request_id=$2', [T, ORID])).rows[0]
  assert.ok(o1, 'outcome row intact'); assert.equal(o1.payload_hmac, null, 'still unfilled (nothing half-done)')
  const t1 = (await client.query(`SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND tool_name='report_outcome'`, [T])).rows[0].n
  assert.equal(t1, 1, 'tool_requests evidence intact')
  const led = (await client.query('SELECT count(*)::INT4 AS n FROM schema_migrations WHERE version >= 14')).rows[0].n
  assert.equal(led, 0, 'no 014+ ledger entries')
  console.log('PASS 1 standard migrate refuses at 014; evidence intact on both sides')

  await client.query(
    `UPDATE outcomes o SET payload_hmac = tr.payload_hmac, response_json = tr.response_json
     FROM tool_requests tr
     WHERE tr.tenant_id = o.tenant_id AND tr.agent_id = o.agent_id AND tr.tool_name = 'report_outcome'
       AND tr.request_id = o.outcome_request_id AND (o.payload_hmac IS NULL OR o.response_json IS NULL)`)

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
})

// ===== Act 2: 已越过 014（证据已丢）-> 016 拒 -> README marker SQL -> 全通、行存续 =====
await disposable(async (client) => {
  const migrations = await loadMigrations()
  await ensureMigrationLedger(client)
  // 推进到 015：库干净所以 014 preflight 放行——正是"已越过 014"的历史状态
  for (const m of migrations.filter(m => m.version <= 15)) {
    assert.equal(await applyOne(client, m), 'applied', m.filename)
  }
  // 此刻才出现的 NULL legacy 行 = tool_requests 副本已被 014 删掉、证据不可恢复的库
  const ORID = randomUUID()
  await client.query(
    `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied)
     VALUES ($1,$2,$3,'ep','task','att-marker','cancelled','[]',false)`, [T, ORID, A])

  await assert.rejects(
    async () => { for (const m of migrations.filter(m => m.version >= 16)) await applyOne(client, m) },
    (e) => e.message.includes('PREFLIGHT 016 REFUSED') && e.message.includes('legacy_outcome_unreplayable') && e.message.includes('Do NOT delete'),
    '016 must refuse with marker guidance when evidence is gone')
  const still = (await client.query('SELECT payload_hmac FROM outcomes WHERE tenant_id=$1 AND outcome_request_id=$2', [T, ORID])).rows[0]
  assert.ok(still, 'legacy row untouched by refused run'); assert.equal(still.payload_hmac, null)
  console.log('PASS 3 past-014 database: 016 refuses, row intact')

  // README 恢复手册的 marker SQL 原文（'\x00' 为 SQL bytes 字面量，JS 里写 \\x00）
  await client.query(
    `UPDATE public.outcomes SET payload_hmac = '\\x00', response_json = '{"legacy_outcome_unreplayable": true}'
     WHERE payload_hmac IS NULL OR response_json IS NULL`)

  for (const m of migrations.filter(m => m.version >= 16)) {
    assert.equal(await applyOne(client, m), 'applied', m.filename)
  }
  const row = (await client.query('SELECT payload_hmac, response_json FROM outcomes WHERE tenant_id=$1 AND outcome_request_id=$2', [T, ORID])).rows[0]
  assert.ok(row, 'marker row SURVIVED 016 (never deleted)')
  assert.equal(row.payload_hmac.length, 1, 'marker hmac is exactly one byte')
  assert.equal(row.payload_hmac[0], 0x00, 'marker hmac is 0x00')
  assert.equal(row.response_json.legacy_outcome_unreplayable, true, 'unreplayable marker persisted through 017 NOT NULL')
  const total = (await client.query('SELECT count(*)::INT4 AS n FROM schema_migrations')).rows[0].n
  assert.equal(total, migrations.length, 'ledger complete on marker branch')
  console.log('PASS 4 marker SQL -> 016-019 green; marker row survives with claim + slot occupied')
})

console.log('ALL MIGRATE INTEGRATION TESTS PASSED')
