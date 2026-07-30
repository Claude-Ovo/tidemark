// Tidemark Memory MCP（P0-03 纵切：remember + admission + 幂等）
// 运行: node --env-file=.env src/server.mjs  （仓库根执行；EMBED_PROVIDER=stub 本地开发）
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { rememberTool } from './tools/remember.mjs'
import { recallTool } from './tools/recall.mjs'
import { logEventTool, EVENT_TYPES } from './tools/log-event.mjs'
import { isRetryableDatabaseError } from '../migrations/db.mjs'

// spike 同款受控 auth 映射；真实认证上下文接入排 P0-09（Secrets/API key）
const AUTH_MAP = {
  'spike-demo-key':   { tenant_id: 'demo-tenant', agent_id: 'demo-agent' },
  'spike-second-key': { tenant_id: 'demo-tenant', agent_id: 'second-agent' },
}

// 工具级瞬断韧性：底层事务各自重试 5 次后仍失败（serverless 集群连续掐连接）时，
// 整个工具调用重试一次——幂等台账保证无重复副作用。每次重试都打日志，绝不静默掩盖。
const runToolResilient = async (label, fn) => {
  for (let attempt = 1; ; attempt++) {
    try { return await fn() }
    catch (e) {
      const retryable = isRetryableDatabaseError(e) || e.code === '40001'
      console.error(JSON.stringify({ evt: `${label}_error`, attempt, code: e.code, retryable, msg: e.message?.slice(0, 160) }))
      if (!retryable || attempt >= 2) return { ok: false, error: 'internal_error' }
      await new Promise(r => setTimeout(r, 1200))
    }
  }
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.get('/health', (_req, res) => res.json({ ok: true, service: 'tidemark-memory-mcp', tools: ['remember', 'recall', 'log_event'] }))

app.post('/mcp', async (req, res) => {
  if (!req.rawHeaders || req.rawHeaders.length === 0) {   // serverless-http shim（本地无害）
    req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.flatMap(x => [k, x]) : [k, String(v)])
  }
  const principal = AUTH_MAP[req.headers['x-tidemark-auth']] ?? null
  const asResult = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: body.ok === false })

  const server = new McpServer({ name: 'tidemark-memory', version: '0.1.0' })
  server.tool('remember',
    'store one memory (admission-gated, idempotent). episode_id + request_id required.',
    { content: z.string(), episode_id: z.string(), request_id: z.string(), kind: z.string().optional(), importance: z.number().optional() },
    async (args) => asResult(await runToolResilient('remember', () => rememberTool({ principal, ...args }))))
  server.tool('recall',
    'semantic recall with lifecycle rerank and persisted content-free receipt. query/purpose/episode_id/attempt_id/request_id required; token_budget optionally tightens total injection (never widens per-layer hard caps).',
    { query: z.string(), purpose: z.string(), episode_id: z.string(), attempt_id: z.string(), request_id: z.string(), token_budget: z.number().int().positive().optional() },
    async (args) => asResult(await runToolResilient('recall', () => recallTool({ principal, ...args }))))
  server.tool('log_event',
    'append one attempt event to the evidence ledger (idempotent). memory_used events are server-validated against the receipt.',
    { episode_id: z.string(), task_instance_id: z.string(), attempt_id: z.string(), event_type: z.enum(EVENT_TYPES),
      request_id: z.string(), tool_name: z.string().optional(), payload: z.record(z.string(), z.any()).optional() },
    async (args) => asResult(await runToolResilient('log_event', () => logEventTool({ principal, ...args }))))

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

const port = Number(process.env.PORT || 3901)
app.listen(port, () => console.log(`tidemark-memory-mcp listening :${port}`))
