// spike 验收（带断言）：官方 SDK 客户端 + 受控 auth header，端到端贯通并回查
// 运行: node client-test.mjs <api-base-url>   非零退出码 = 失败
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'

const url = process.argv[2]
assert.ok(url, 'usage: node client-test.mjs <base-url>')

const connect = (headers) => {
  const client = new Client({ name: 'tidemark-spike-client', version: '0.0.2' })
  return client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } })).then(() => client)
}

// 1. 无 auth：probe 必须拒绝
{
  const c = await connect({})
  const r = JSON.parse((await c.callTool({ name: 'probe_memory', arguments: { content: 'x' } })).content[0].text)
  assert.equal(r.ok, false, 'probe without auth must be rejected')
  await c.close()
  console.log('PASS unauthorized probe rejected')
}

// 2. 带 auth：端到端 probe → 拿 request_id → 回查同一行
{
  const c = await connect({ 'x-tidemark-auth': 'spike-demo-key' })
  const tools = (await c.listTools()).tools.map(t => t.name)
  assert.ok(tools.includes('probe_memory') && tools.includes('probe_lookup'), 'tools present')
  const t0 = Date.now()
  const probe = JSON.parse((await c.callTool({ name: 'probe_memory', arguments: { content: 'the tide leaves a mark' } })).content[0].text)
  assert.equal(probe.ok, true, `probe failed: ${JSON.stringify(probe)}`)
  assert.equal(probe.tenant_id, 'demo-tenant', 'auth mapped to demo tenant')
  assert.equal(probe.embedding_dims, 512, 'bedrock returned 512-dim embedding')
  const lookup = JSON.parse((await c.callTool({ name: 'probe_lookup', arguments: { request_id: probe.request_id } })).content[0].text)
  assert.equal(lookup.ok, true, 'row found by request_id')
  assert.equal(lookup.row.model_id, probe.model_id, 'model_id matches')
  await c.close()
  console.log(`PASS end-to-end auth->bedrock->crdb->lookup (${Date.now() - t0}ms) request_id=${probe.request_id}`)
}

// 3. 未知 tool：报错但不搞挂服务（下一请求仍绿）
{
  const c = await connect({ 'x-tidemark-auth': 'spike-demo-key' })
  const bad = await c.callTool({ name: 'nope', arguments: {} }).catch(e => ({ isError: true, caught: e.message }))
  assert.ok(bad.isError, 'unknown tool must surface as error (isError result or rejection)')
  await c.close()
  const c2 = await connect({})
  const pong = (await c2.callTool({ name: 'ping', arguments: { msg: 'still alive' } })).content[0].text
  assert.ok(pong.includes('still alive'), 'warm request after error still green')
  await c2.close()
  console.log('PASS error path does not poison warm container')
}

console.log('ALL SPIKE ASSERTIONS PASSED')
