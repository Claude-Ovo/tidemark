// spike 验收（带断言）：node client-test.mjs <base-url> <expected_provider: stub|bedrock>
// 非零退出码 = 失败。五场景：无auth拒绝(isError)/端到端+digest核验/越权隔离/未知tool不毒化/并发pool行为
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'

const url = process.argv[2]
const expectedProvider = process.argv[3]
assert.ok(url && ['stub', 'bedrock'].includes(expectedProvider), 'usage: node client-test.mjs <base-url> <stub|bedrock>')
const expectedModel = expectedProvider === 'bedrock' ? 'amazon.titan-embed-text-v2:0' : 'stub-sha256-512'
const chainLabel = `auth->${expectedProvider}->crdb`

const connect = async (headers) => {
  const client = new Client({ name: 'tidemark-spike-client', version: '0.0.3' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  return client
}
const callJson = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args })
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) }
}

// 1. 无 auth：probe 必须以 isError 拒绝（协议语义，不只是正文 ok=false）
{
  const c = await connect({})
  const { isError, body } = await callJson(c, 'probe_memory', { content: 'x' })
  assert.equal(isError, true, 'unauthorized must be isError:true at MCP level')
  assert.equal(body.ok, false)
  await c.close()
  console.log('PASS 1 unauthorized probe rejected with isError')
}

// 2. 端到端：probe → lookup 回查 DB 内真实向量并核验 digest
let probeRequestId
{
  const c = await connect({ 'x-tidemark-auth': 'spike-demo-key' })
  const t0 = Date.now()
  const { body: probe } = await callJson(c, 'probe_memory', { content: 'the tide leaves a mark' })
  assert.equal(probe.ok, true, `probe failed: ${JSON.stringify(probe)}`)
  assert.equal(probe.provider, expectedProvider, `provider must be ${expectedProvider}`)
  assert.equal(probe.model_id, expectedModel, 'model_id matches expected provider')
  assert.equal(probe.tenant_id, 'demo-tenant'); assert.equal(probe.agent_id, 'demo-agent')
  const { body: lookup } = await callJson(c, 'probe_lookup', { request_id: probe.request_id })
  assert.equal(lookup.ok, true, 'row found in agent scope')
  assert.equal(lookup.tenant_id, 'demo-tenant'); assert.equal(lookup.agent_id, 'demo-agent')
  assert.equal(lookup.model_id, expectedModel)
  assert.equal(lookup.digest_match, true, 'digest recomputed from DB vector must match stored digest')
  assert.equal(lookup.stored_sha256, probe.embedding_sha256, 'DB digest matches probe-time digest')
  probeRequestId = probe.request_id
  await c.close()
  console.log(`PASS 2 end-to-end ${chainLabel} + digest verified (${Date.now() - t0}ms) request_id=${probe.request_id}`)
}

// 3. 越权隔离：同 tenant 第二个 agent 拿 request_id 不得查到第一 agent 的行
{
  const c = await connect({ 'x-tidemark-auth': 'spike-second-key' })
  const { body } = await callJson(c, 'probe_lookup', { request_id: probeRequestId })
  assert.equal(body.ok, false, 'cross-agent lookup must fail (agent-scoped)')
  assert.equal(body.error, 'not_found_in_scope')
  await c.close()
  console.log('PASS 3 cross-agent isolation enforced')
}

// 4. 未知 tool 报错后 warm 容器仍绿
{
  const c = await connect({ 'x-tidemark-auth': 'spike-demo-key' })
  const bad = await c.callTool({ name: 'nope', arguments: {} }).catch(e => ({ isError: true, caught: e.message }))
  assert.ok(bad.isError, 'unknown tool surfaces as error')
  await c.close()
  const c2 = await connect({})
  const pong = (await c2.callTool({ name: 'ping', arguments: { msg: 'still alive' } })).content[0].text
  assert.ok(pong.includes('still alive'))
  await c2.close()
  console.log('PASS 4 error path does not poison warm container')
}

// 5. 并发：pool max=1 下 4 路并发 probe 全部成功（排队而非失败）
{
  const cs = await Promise.all([1, 2, 3, 4].map(() => connect({ 'x-tidemark-auth': 'spike-demo-key' })))
  const t0 = Date.now()
  const rs = await Promise.all(cs.map((c, i) => callJson(c, 'probe_memory', { content: `concurrent-${i}` })))
  rs.forEach((r, i) => assert.equal(r.body.ok, true, `concurrent probe ${i} failed`))
  const ids = new Set(rs.map(r => r.body.request_id))
  assert.equal(ids.size, 4, 'four distinct request_ids')
  await Promise.all(cs.map(c => c.close()))
  console.log(`PASS 5 concurrency under pool max=1: 4/4 ok (${Date.now() - t0}ms total)`)
}

console.log(`ALL SPIKE ASSERTIONS PASSED (provider=${expectedProvider})`)
