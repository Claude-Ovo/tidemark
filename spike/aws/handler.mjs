// P0-01 spike: Lambda + API Gateway 承载真实 MCP transport + 端到端业务链验证
// probe_memory: 一个请求贯通 auth→tenant 映射→Bedrock embedding→CRDB 落行
import express from 'express'
import serverless from 'serverless-http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import pg from 'pg'
import { z } from 'zod'

const app = express()
app.use(express.json({ limit: '1mb' }))

// ---- 共享资源（Lambda 生命周期级复用） ----
let pool
const getPool = () => {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.COCKROACH_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 8000,   // 远小于 Lambda 30s timeout
    })
    pool.on('error', (e) => console.error(JSON.stringify({ evt: 'pool_idle_error', msg: e.message.slice(0, 120) })))
  }
  return pool
}
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' })
const EMBED_MODEL = 'amazon.titan-embed-text-v2:0'

// provider 层：bedrock（生产）| stub（Bedrock 审批期间的确定性替身，同维度同接口）
// 切换只动 EMBED_PROVIDER 环境变量；stub 结果由内容哈希驱动，可复现、可断言
import { createHash } from 'node:crypto'
const embedProviders = {
  bedrock: async (text) => {
    const r = await bedrock.send(new InvokeModelCommand({
      modelId: EMBED_MODEL, contentType: 'application/json', accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: 512 })
    }))
    return { embedding: JSON.parse(new TextDecoder().decode(r.body)).embedding, model_id: EMBED_MODEL }
  },
  stub: async (text) => {
    const h = createHash('sha256').update(text).digest()
    const embedding = Array.from({ length: 512 }, (_, i) => (h[i % 32] / 255) * 2 - 1)
    return { embedding, model_id: 'stub-sha256-512 (pending bedrock allowlisting)' }
  }
}
const embed = embedProviders[process.env.EMBED_PROVIDER || 'bedrock']

// ---- spike 专用 auth 映射：受控 header → 固定 demo principal（真实实现在 P0-03 换成认证上下文） ----
const AUTH_MAP = { 'spike-demo-key': { tenant_id: 'demo-tenant', agent_id: 'demo-agent' } }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'tidemark-spike', region: process.env.AWS_REGION }))

app.post('/mcp', async (req, res) => {
  // serverless-http 的 mock 请求缺 rawHeaders，SDK 底层 Hono 转换依赖它——手动补齐
  if (!req.rawHeaders || req.rawHeaders.length === 0) {
    req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.flatMap(x => [k, x]) : [k, String(v)])
  }
  const principal = AUTH_MAP[req.headers['x-tidemark-auth']] ?? null

  const server = new McpServer({ name: 'tidemark-spike', version: '0.0.2' })
  server.tool('ping', 'spike echo test', { msg: z.string() }, async ({ msg }) => ({
    content: [{ type: 'text', text: `pong: ${msg} | region=${process.env.AWS_REGION}` }]
  }))
  server.tool('probe_memory', 'end-to-end probe: auth->tenant->bedrock->crdb', { content: z.string() }, async ({ content }) => {
    if (!principal) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unauthorized: missing/unknown x-tidemark-auth' }) }] }
    const request_id = randomUUID()
    const { embedding, model_id } = await embed(content)
    const p = getPool()
    await p.query(`CREATE TABLE IF NOT EXISTS spike_probe (
      tenant_id STRING NOT NULL, agent_id STRING NOT NULL, request_id UUID NOT NULL,
      model_id STRING NOT NULL, embedding_dims INT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, request_id))`)
    await p.query('INSERT INTO spike_probe (tenant_id, agent_id, request_id, model_id, embedding_dims) VALUES ($1,$2,$3,$4,$5)',
      [principal.tenant_id, principal.agent_id, request_id, model_id, embedding.length])
    console.log(JSON.stringify({ evt: 'probe_memory', request_id, tenant_id: principal.tenant_id, agent_id: principal.agent_id, dims: embedding.length }))
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, request_id, tenant_id: principal.tenant_id, agent_id: principal.agent_id, model_id, embedding_dims: embedding.length }) }] }
  })
  server.tool('probe_lookup', 'verify probe row exists by request_id', { request_id: z.string() }, async ({ request_id }) => {
    if (!principal) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unauthorized' }) }] }
    const r = await getPool().query('SELECT tenant_id, agent_id, model_id, embedding_dims FROM spike_probe WHERE tenant_id=$1 AND request_id=$2',
      [principal.tenant_id, request_id])
    return { content: [{ type: 'text', text: JSON.stringify({ ok: r.rowCount === 1, row: r.rows[0] ?? null }) }] }
  })

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error(JSON.stringify({ evt: 'mcp_handler_error', msg: e?.message?.slice(0, 200) }))
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
  } finally {
    try { await server.close() } catch (ce) { console.error(JSON.stringify({ evt: 'server_close_error', msg: ce?.message?.slice(0, 120) })) }
  }
})

export const handler = serverless(app)
