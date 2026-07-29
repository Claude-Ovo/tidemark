// spike 表迁移。用法: node --env-file=../../.env migrate.mjs [--reset]
// --reset 会 DROP 重建（显式销毁 spike 证据行，慎用）；无 --reset 时只做幂等 CREATE IF NOT EXISTS
import pg from 'pg'
if (!process.env.COCKROACH_DATABASE_URL) { console.error('missing COCKROACH_DATABASE_URL (use node --env-file=../../.env)'); process.exit(1) }
// serverless 集群冷恢复时首连可能 ECONNRESET——瞬断重试 3 次，指数退避
let c
for (let attempt = 1; ; attempt++) {
  c = new pg.Client({ connectionString: process.env.COCKROACH_DATABASE_URL, connectionTimeoutMillis: 8000 })
  try { await c.connect(); break }
  catch (e) {
    await c.end().catch(() => {})   // 失败的 client 也要关，防句柄泄漏
    if (attempt >= 3) throw e
    console.error(`connect attempt ${attempt} failed (${e.code || e.message}), retrying...`)
    await new Promise(r => setTimeout(r, 1500 * attempt))
  }
}
try {
if (process.argv.includes('--reset')) {
  await c.query('DROP TABLE IF EXISTS spike_probe')
  console.log('spike_probe dropped (--reset: previous spike evidence rows destroyed)')
}
await c.query(`CREATE TABLE IF NOT EXISTS spike_probe (
  tenant_id STRING NOT NULL,
  agent_id  STRING NOT NULL,
  request_id UUID NOT NULL,
  model_id  STRING NOT NULL,
  embedding VECTOR(512) NOT NULL,
  embedding_sha256 STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, request_id))`)

// schema 形态校验：旧版表（a4bee54 无 VECTOR、PK 缺 agent_id）会被 IF NOT EXISTS 静默放过——显式失败并提示 reset
const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='spike_probe'`)).rows.map(r => r.column_name)
const pk = (await c.query(`SELECT column_name FROM information_schema.key_column_usage WHERE table_name='spike_probe' AND constraint_name='spike_probe_pkey' ORDER BY ordinal_position`)).rows.map(r => r.column_name)
const wantCols = ['embedding', 'embedding_sha256'], wantPk = ['tenant_id', 'agent_id', 'request_id']
if (!wantCols.every(x => cols.includes(x)) || JSON.stringify(pk) !== JSON.stringify(wantPk)) {
  console.error(`spike_probe schema mismatch (cols=${cols.join(',')}; pk=${pk.join(',')}).`)
  console.error('An older-generation table exists. Re-run with: .\\deploy.ps1 -ResetSpikeTable (destroys previous spike evidence rows).')
  await c.end(); process.exit(2)
}
console.log('spike_probe ready (agent-scoped PK, VECTOR column, schema shape verified)')
} finally { await c.end().catch(() => {}) }   // 查询异常也保证连接关闭
