// embedding 身份隔离验收（结论 55：旧空间与当前空间绝不混检索）。
// 走真实 server(:3901, stub provider) + 真实 DB：直接在库里种一行【同向量但异身份】的
// "外星空间"行——recall 两路都必须视而不见；同 tenant/agent 的合法行照常返回。
// 需要: 本地 server 运行中 + .env
import './lib/test-env.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { withDatabase } from '../migrations/db.mjs'

const DB = new pg.Pool({ connectionString: withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev'), max: 2 })
// serverless 冷唤醒 ECONNRESET 重试圈（只读/幂等语句，重试安全）
const q = async (text, values) => {
  for (let i = 1; ; i++) {
    try { return await DB.query(text, values) }
    catch (e) {
      if (i >= 5 || !/ECONNRESET|ETIMEDOUT|57P01|08006/.test(String(e.code ?? e.message))) throw e
      await new Promise(r => setTimeout(r, 500 * i))
    }
  }
}
const URL_BASE = 'http://localhost:3901'
const TENANT = 'demo-tenant', AGENT = 'demo-agent'
const suite = 'iso-' + randomUUID().slice(0, 8)

const withClient = async (fn) => {
  const c = new Client({ name: 'tidemark-iso-test', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_BASE + '/mcp'), { requestInit: { headers: { 'x-tidemark-auth': 'spike-demo-key' } } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args })
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) }
}

try {
  const episode = `${suite}-ep`
  const content = `isolation probe ${suite}: the tide leaves an isolated mark`

  await withClient(async (c) => {
    // I0 合法行入库（stub 身份）并确认可召回
    const rem = await call(c, 'remember', { content, episode_id: episode, request_id: randomUUID() })
    assert.equal(rem.body.ok, true, JSON.stringify(rem.body))
    const legitId = rem.body.memory_id

    const rec0 = await call(c, 'recall', { query: content, purpose: 'iso', episode_id: episode, attempt_id: `${suite}-a0`, request_id: randomUUID() })
    assert.ok(rec0.body.receipt.items.some(i => i.memory_id === legitId), 'I0 legit row recallable')
    console.log('PASS I0 same-space row recallable')

    // I1 外星空间行：抄合法行的向量（= 对查询向量距离完全相同），身份换成 alien。
    // 若 recall 没有身份过滤，它必然与合法行并肩入选。pinned+importance 拉满使其
    // 同时满足 path B 的准入——两路同时布防。
    const alienId = randomUUID()
    const legit = (await q('SELECT embedding::STRING AS emb FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, legitId])).rows[0]
    await q(
      `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, embedding_model_id,
         source, admission, state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours)
       VALUES ($1,$2,$3,'event',$4,$5,$6,'alien-space-v1','agent_inferred','accepted','fresh',true,0.95,1.0,now(),now(),48)`,
      [TENANT, AGENT, alienId, episode, `alien twin of ${suite}`, legit.emb])

    const rec1 = await call(c, 'recall', { query: content, purpose: 'iso', episode_id: episode, attempt_id: `${suite}-a1`, request_id: randomUUID() })
    assert.equal(rec1.body.ok, true)
    assert.ok(rec1.body.receipt.items.some(i => i.memory_id === legitId), 'I1 legit row survives')
    assert.ok(!rec1.body.receipt.items.some(i => i.memory_id === alienId), 'I1 alien-space row must be invisible to recall (both paths)')
    console.log('PASS I1 alien-identity row invisible to recall despite identical vector + pinned')
  })
  console.log(`ALL EMBED-ISOLATION ASSERTIONS PASSED (${suite})`)
} finally {
  const del = await q(`DELETE FROM memories WHERE tenant_id=$1 AND (episode_id LIKE $2 OR content LIKE $3)`, [TENANT, `${suite}%`, `%${suite}%`])
  const res = (await q(`SELECT count(*)::INT AS n FROM memories WHERE tenant_id=$1 AND episode_id LIKE $2`, [TENANT, `${suite}%`])).rows[0].n
  await q(`DELETE FROM recall_requests WHERE tenant_id=$1 AND attempt_id LIKE $2`, [TENANT, `${suite}%`])
  // tool_requests 幂等残档是 content-free 的，留着无害；不做整租户误伤清理
  console.log(`cleanup done (deleted ${del.rowCount}, residual ${res})`)
  await DB.end()
}
