// Spike 第一步：验证 CRDB Cloud 连通性 + VECTOR 能力
// 运行: node spike/connectivity.mjs
import 'dotenv/config'
import pg from 'pg'

const url = process.env.COCKROACH_DATABASE_URL
if (!url) { console.error('缺 COCKROACH_DATABASE_URL'); process.exit(1) }

const client = new pg.Client({ connectionString: url })
const results = []
const step = async (name, fn) => {
  try { const r = await fn(); results.push([name, 'OK', r ?? '']) }
  catch (e) { results.push([name, 'FAIL', e.message.slice(0, 120)]) }
}

await step('connect', () => client.connect())
await step('version', async () => (await client.query('SELECT version()')).rows[0].version.slice(0, 60))
await step('create table (VECTOR col)', () =>
  client.query('CREATE TABLE IF NOT EXISTS spike_mem (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content STRING, embedding VECTOR(4))'))
await step('vector index', () =>
  client.query('CREATE VECTOR INDEX IF NOT EXISTS spike_vec_idx ON spike_mem (embedding)'))
await step('insert vector row', () =>
  client.query("INSERT INTO spike_mem (content, embedding) VALUES ('hello memory', '[0.1,0.2,0.3,0.4]')"))
await step('vector distance query', async () => {
  const r = await client.query("SELECT content, embedding <-> '[0.1,0.2,0.3,0.5]' AS dist FROM spike_mem ORDER BY dist LIMIT 1")
  return `top1="${r.rows[0].content}" dist=${Number(r.rows[0].dist).toFixed(4)}`
})
await step('atomic UPDATE...RETURNING', async () => {
  const r = await client.query("UPDATE spike_mem SET content = content || '!' WHERE content LIKE 'hello%' RETURNING content")
  return r.rows[0]?.content
})
await step('cleanup', () => client.query('DROP TABLE spike_mem'))
await client.end()

for (const [n, s, d] of results) console.log(`${s.padEnd(5)} ${n}${d ? '  -- ' + d : ''}`)
process.exit(results.some(r => r[1] === 'FAIL') ? 1 : 0)
