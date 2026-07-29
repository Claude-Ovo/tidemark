// spike 表迁移（从 tool 调用里移出，deploy 时执行一次）
import 'dotenv/config'
import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.COCKROACH_DATABASE_URL })
await c.connect()
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
