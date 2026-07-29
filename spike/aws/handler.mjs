// P0-01 spike: 验证 Lambda + Function URL 能否承载真实 MCP streamable-http transport
// 无状态模式：每请求新建 server+transport（与 weather-mcp 同款模式）
import express from 'express'
import serverless from 'serverless-http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => res.json({ ok: true, service: 'tidemark-spike', region: process.env.AWS_REGION, coldStart: COLD }))
app.post('/debug', (req, res) => res.json({ headers: req.headers }))

// spike: Lambda 内部连 CRDB（TLS + 单连接池验证）
import pg from 'pg'
let pool
app.get('/dbcheck', async (_req, res) => {
  try {
    pool ??= new pg.Pool({ connectionString: process.env.COCKROACH_DATABASE_URL, max: 1 })
    const r = await pool.query('SELECT version() AS v, now() AS t')
    res.json({ ok: true, version: r.rows[0].v.slice(0, 40), server_time: r.rows[0].t })
  } catch (e) { res.status(500).json({ ok: false, error: e.message.slice(0, 200) }) }
})

let COLD = true
app.post('/mcp', async (req, res) => {
  const wasCold = COLD; COLD = false
  // serverless-http 的 mock 请求缺 rawHeaders，SDK 底层 Hono 转换依赖它——手动补齐
  if (!req.rawHeaders || req.rawHeaders.length === 0) {
    req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.flatMap(x => [k, x]) : [k, String(v)])
  }
  const server = new McpServer({ name: 'tidemark-spike', version: '0.0.1' })
  server.tool('ping', 'spike echo test', { msg: z.string() }, async ({ msg }) => ({
    content: [{ type: 'text', text: `pong: ${msg} | region=${process.env.AWS_REGION} | coldStart=${wasCold}` }]
  }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

export const handler = serverless(app)
