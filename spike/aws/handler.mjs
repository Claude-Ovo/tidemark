// P0-01 spike: Lambda + API Gateway 承载真实 MCP transport + 端到端业务链验证
// probe_memory: 一个请求贯通 auth→tenant/agent 映射→embedding→CRDB 落行（含真实向量+digest）
import express from 'express'
import serverless from 'serverless-http'
import { randomUUID, createHash } from 'node:crypto'
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
      connectionTimeoutMillis: 8000,
    })
    pool.on('error', (e) => console.error(JSON.stringify({ evt: 'pool_idle_error', msg: e.message.slice(0, 120) })))
  }
  return pool
}
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' })
const EMBED_MODEL = 'amazon.titan-embed-text-v2:0'

// provider 层：bedrock（生产）| stub（Bedrock allowlisting 审批期间的确定性替身）
const embedProviders = {
  bedrock: async (text) => {
    const r = await bedrock.send(new InvokeModelCommand({
      modelId: EMBED_MODEL, contentType: 'application/json', accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: 512 })
    }))
    return { embedding: JSON.parse(new TextDecoder().decode(r.body)).embedding, model_id: EMBED_MODEL, provider: 'bedrock' }
  },
  stub: async (text) => {
    const h = createHash('sha256').update(text).digest()
    const embedding = Array.from({ length: 512 }, (_, i) => (h[i % 32] / 255) * 2 - 1)
    return { embedding, model_id: 'stub-sha256-512', provider: 'stub' }
  }
}
const PROVIDER = process.env.EMBED_PROVIDER || 'bedrock'
if (!embedProviders[PROVIDER]) throw new Error(`invalid EMBED_PROVIDER "${PROVIDER}" (expected bedrock|stub)`)
const embed = embedProviders[PROVIDER]

// canonical digest：4 位小数定点化后 sha256——两侧（写入前/读回后）同一算法，抗 float32 roundtrip
const canonicalDigest = (vec) => createHash('sha256').update(vec.map(v => v.toFixed(4)).join(',')).digest('hex')
const toVectorLiteral = (vec) => '[' + vec.map(v => v.toFixed(6)).join(',') + ']'
const parseVector = (s) => s.replace(/^\[|\]$/g, '').split(',').map(Number)

// spike 专用 auth 映射：两个受控 principal（第二个用于越权测试）
const AUTH_MAP = {
  'spike-demo-key':   { tenant_id: 'demo-tenant', agent_id: 'demo-agent' },
  'spike-second-key': { tenant_id: 'demo-tenant', agent_id: 'second-agent' },
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'tidemark-spike', region: process.env.AWS_REGION, provider: PROVIDER }))

app.post('/mcp', async (req, res) => {
  // serverless-http 的 mock 请求缺 rawHeaders，SDK 底层 Hono 转换依赖它——手动补齐
  if (!req.rawHeaders || req.rawHeaders.length === 0) {
    req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.flatMap(x => [k, x]) : [k, String(v)])
  }
  const principal = AUTH_MAP[req.headers['x-tidemark-auth']] ?? null
  const unauthorized = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unauthorized' }) }], isError: true })

  const server = new McpServer({ name: 'tidemark-spike', version: '0.0.3' })
  server.tool('ping', 'spike echo test', { msg: z.string() }, async ({ msg }) => ({
    content: [{ type: 'text', text: `pong: ${msg} | region=${process.env.AWS_REGION}` }]
  }))
  server.tool('probe_memory', 'end-to-end probe: auth->tenant/agent->embed->crdb(vector+digest)', { content: z.string() }, async ({ content }) => {
    if (!principal) return unauthorized()
    const request_id = randomUUID()
    const { embedding, model_id, provider } = await embed(content)
    const digest = canonicalDigest(embedding)
    await getPool().query(
      'INSERT INTO spike_probe (tenant_id, agent_id, request_id, model_id, embedding, embedding_sha256) VALUES ($1,$2,$3,$4,$5,$6)',
      [principal.tenant_id, principal.agent_id, request_id, model_id, toVectorLiteral(embedding), digest])
    console.log(JSON.stringify({ evt: 'probe_memory', request_id, tenant_id: principal.tenant_id, agent_id: principal.agent_id, provider, dims: embedding.length }))
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, request_id, tenant_id: principal.tenant_id, agent_id: principal.agent_id, model_id, provider, embedding_sha256: digest }) }] }
  })
  server.tool('probe_lookup', 'verify probe row: recompute digest from DB vector, agent-scoped', { request_id: z.string() }, async ({ request_id }) => {
    if (!principal) return unauthorized()
    const r = await getPool().query(
      'SELECT tenant_id, agent_id, model_id, embedding::STRING AS emb, embedding_sha256 FROM spike_probe WHERE tenant_id=$1 AND agent_id=$2 AND request_id=$3',
      [principal.tenant_id, principal.agent_id, request_id])
    if (r.rowCount !== 1) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_found_in_scope' }) }] }
    const row = r.rows[0]
    const recomputed = canonicalDigest(parseVector(row.emb))
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tenant_id: row.tenant_id, agent_id: row.agent_id, model_id: row.model_id, stored_sha256: row.embedding_sha256, recomputed_sha256: recomputed, digest_match: recomputed === row.embedding_sha256 }) }] }
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
