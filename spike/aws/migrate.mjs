// spike 表迁移。用法: node --env-file=../../.env migrate.mjs [--reset]
// --reset 会 DROP 重建（显式销毁 spike 证据行，慎用）；无 --reset 时只做幂等 CREATE IF NOT EXISTS
import pg from 'pg'
if (!process.env.COCKROACH_DATABASE_URL) { console.error('missing COCKROACH_DATABASE_URL (use node --env-file=../../.env)'); process.exit(1) }
const c = new pg.Client({ connectionString: process.env.COCKROACH_DATABASE_URL })
await c.connect()
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
console.log('spike_probe ready (agent-scoped PK, VECTOR column)')
await c.end()
