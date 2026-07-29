// Tidemark Memory MCP（P0-03 纵切：remember + admission + 幂等）
// 运行: node --env-file=.env src/server.mjs  （仓库根执行；EMBED_PROVIDER=stub 本地开发）
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { rememberTool } from './tools/remember.mjs'

// spike 同款受控 auth 映射；真实认证上下文接入排 P0-09（Secrets/API key）
const AUTH_MAP = {
  'spike-demo-key':   { tenant_id: 'demo-tenant', agent_id: 'demo-agent' },
  'spike-second-key': { tenant_id: 'demo-tenant', agent_id: 'second-agent' },
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.get('/health', (_req, res) => res.json({ ok: true, service: 'tidemark-memory-mcp', tool: 'remember' }))

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
    async (args) => asResult(await rememberTool({ principal, ...args }).catch(e => {
      console.error(JSON.stringify({ evt: 'remember_error', code: e.code, msg: e.message?.slice(0, 160) }))
      return { ok: false, error: 'internal_error' }        // 工具异常也返回结构化 JSON，不裸抛文本
    })))

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
