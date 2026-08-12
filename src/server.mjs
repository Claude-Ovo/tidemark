// Tidemark Memory MCP（P0-03 纵切：remember + admission + 幂等）
// 运行: node --env-file=.env src/server.mjs  （仓库根执行；EMBED_PROVIDER=stub 本地开发）
// P0-09：本文件导出 app（Lambda handler 经 serverless-http 复用同一实例）；
// 仅作为主模块直跑时才 listen——两条运行路径共享全部路由与鉴权语义
import { pathToFileURL } from 'node:url'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { rememberTool } from './tools/remember.mjs'
import { recallTool } from './tools/recall.mjs'
import { logEventTool, EVENT_TYPES } from './tools/log-event.mjs'
import { reportOutcomeTool } from './tools/report-outcome.mjs'
import { pinTool } from './tools/pin.mjs'
import { forgetMemory } from './admin/forget.mjs'
import { vizOcean, vizWaves } from './viz/ocean.mjs'
import { vizActivity } from './viz/activity.mjs'
import { vizMemoryDetail } from './viz/detail.mjs'
import { vizCapability } from './viz/capability.mjs'
import { runJudgeDemo, bucketRunKey } from './viz/judge-run.mjs'
import { embedModelId } from './lib/embed.mjs'
import { isRetryableDatabaseError } from '../migrations/db.mjs'

// 认证上下文（P0-09 接真实密钥源，round-2 修 P0-1 的 fail-open）：
// TIDEMARK_AGENT_KEYS（Secrets Manager 注入的 JSON）存在时【整表取代】内置 dev 映射——
// 生产环境不保留任何硬编码可猜 key。dev 表的可达条件收紧为【显式本地不安全模式且非生产】：
// TIDEMARK_DEV_INSECURE=1 且无 TIDEMARK_SECRET_ARN，两者同时成立才回退；其余一切缺表
// 情形直接抛错（请求得 5xx），配置漂移绝不静默降级。
// 表结构冻结：key -> { tenant_id, agent_id, capabilities[], scope? }
// capabilities：pin 是能力位不是默认权力（冻结 §12.3）——second-agent 故意不带，作越权测试对照
// scope（P0-11 一审 P0-1/P0-2）：缺省 'agent' = 完整工具面；'viz' = 只读观景面——
// 进不了 MCP 五工具，但作为 owner 建的 viewer 键可见全租户海湾清单（agent 键只见自己）。
const DEV_AUTH_MAP = {
  'spike-demo-key':   { tenant_id: 'demo-tenant', agent_id: 'demo-agent', capabilities: ['memory:pin'] },
  'viz-demo-key':     { tenant_id: 'demo-tenant', agent_id: 'demo-agent', capabilities: [], scope: 'viz' },
  'spike-second-key': { tenant_id: 'demo-tenant', agent_id: 'second-agent', capabilities: [] },
  // third-agent 有 pin 能力位：专测"capability 过了、agent scope 也必须过"（两道门独立）
  'spike-third-key':  { tenant_id: 'demo-tenant', agent_id: 'third-agent', capabilities: ['memory:pin'] },
}
let authMapCache = null
export const _resetAuthMapCacheForTest = () => { authMapCache = null }
export const resolveAuthMap = () => {
  if (authMapCache) return authMapCache
  const raw = process.env.TIDEMARK_AGENT_KEYS
  if (!raw) {
    if (process.env.TIDEMARK_DEV_INSECURE === '1' && !process.env.TIDEMARK_SECRET_ARN) return (authMapCache = DEV_AUTH_MAP)
    throw new Error('TIDEMARK_AGENT_KEYS missing: dev key table is only reachable with TIDEMARK_DEV_INSECURE=1 and no TIDEMARK_SECRET_ARN')
  }
  const parsed = JSON.parse(raw)
  // round-3 修 P0（数组绕过）：根节点必须是 plain object map——数组经 Object.entries 会产出
  // 索引键，header 送 "0" 即可认证。JSON.parse 的产物里非 null/array 的 object 即 plain。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TIDEMARK_AGENT_KEYS must be a plain object map of api_key -> principal')
  }
  for (const [k, p] of Object.entries(parsed)) {
    if (!k) throw new Error('TIDEMARK_AGENT_KEYS must not contain an empty api key')
    if (typeof p?.tenant_id !== 'string' || !p.tenant_id || typeof p?.agent_id !== 'string' || !p.agent_id
        || !Array.isArray(p.capabilities) || p.capabilities.some(c => typeof c !== 'string')
        || (p.scope !== undefined && p.scope !== 'agent' && p.scope !== 'viz')) {
      throw new Error(`TIDEMARK_AGENT_KEYS entry invalid for key ${k.slice(0, 4)}***`)
    }
  }
  if (Object.keys(parsed).length === 0) throw new Error('TIDEMARK_AGENT_KEYS must not be empty')
  return (authMapCache = parsed)
}

// viz 键在工具面等同未认证（P0-2 姊妹守卫）：观景键泄露也拿不到写面/召回面。
// 单点收口——MCP 端点唯一一次 principal 解析处过这个闸。
export const toolPrincipal = (p) => (p?.scope === 'viz' ? null : p)

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
// health 同时暴露当前 embedding 身份（审计面：部署产物/DB 隔离/pipeline 版本三处
// 引用的是不是同一个空间，一眼可查——身份是派生值不是配置项，见 embed-identity.mjs）
app.get('/health', (_req, res) => res.json({
  ok: true, service: 'tidemark-memory-mcp',
  tools: ['remember', 'recall', 'log_event', 'report_outcome', 'pin'],
  embedding_model_id: embedModelId(),
}))

// P0-11 viz：只读观景面（agent key 定界，绝不产生 receipt/塑性）。契约见 DESIGN-OCEAN.md。
app.get('/viz/ocean', async (req, res) => {
  const principal = resolveAuthMap()[req.headers['x-tidemark-auth']] ?? null
  try { res.json(await vizOcean({ principal })) }
  catch (e) { console.error(JSON.stringify({ evt: 'viz_ocean_error', msg: e?.message?.slice(0, 160) })); res.status(500).json({ ok: false, error: 'internal_error' }) }
})
app.get('/viz/waves', async (req, res) => {
  const principal = resolveAuthMap()[req.headers['x-tidemark-auth']] ?? null
  try { res.json(await vizWaves({ principal, after: req.query.after, limit: req.query.limit })) }
  catch (e) { console.error(JSON.stringify({ evt: 'viz_waves_error', msg: e?.message?.slice(0, 160) })); res.status(500).json({ ok: false, error: 'internal_error' }) }
})
// P0-11 契约 D：memory 详情（hover/drawer 冷启动真源，principal-aware，只读）
app.get('/viz/memory/:memory_id', async (req, res) => {
  const principal = resolveAuthMap()[req.headers['x-tidemark-auth']] ?? null
  try { res.json(await vizMemoryDetail({ principal, memory_id: req.params.memory_id })) }
  catch (e) { console.error(JSON.stringify({ evt: 'viz_detail_error', msg: e?.message?.slice(0, 160) })); res.status(500).json({ ok: false, error: 'internal_error' }) }
})
// Judge Demo 触发面（2026-08-12）：POST 才触发，GET 路由一律只读——写入落在
// 【服务端选定】的 sacrificial demo agent 上，调用方不能指定写到哪里；run key 取时间桶，
// 桶内重复点击走各工具幂等层原路返回（不产生新行），下一个桶才是新证明。
app.post('/viz/judge-run', async (req, res) => {
  const principal = resolveAuthMap()[req.headers['x-tidemark-auth']] ?? null
  if (!principal) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    res.json(await runJudgeDemo({ runKey: bucketRunKey(Date.now()) }))
  } catch (e) {
    console.error(JSON.stringify({ evt: 'judge_run_error', msg: e?.message?.slice(0, 160) }))
    res.status(500).json({ ok: false, error: e?.message?.startsWith('judge_') ? e.message : 'internal_error' })
  }
})
// 证据前端（2026-08-12）：能力索引——StatusStrip 的真实状态与 System Map 的诚实来源。
// 每个条目带 live / documented / evidence_pending / blocked_external / unavailable 状态，
// 绝不把未完成的集成伪装成 live telemetry。
app.get('/viz/capability', async (req, res) => {
  const principal = resolveAuthMap()[req.headers['x-tidemark-auth']] ?? null
  try { res.json(await vizCapability({ principal })) }
  catch (e) { console.error(JSON.stringify({ evt: 'viz_capability_error', msg: e?.message?.slice(0, 160) })); res.status(500).json({ ok: false, error: 'internal_error' }) }
})
// P0-11 v2 活动流（契约 B + SPEC §14）：closed watermark + hot-window 重放，客户端去重
app.get('/viz/activity', async (req, res) => {
  const principal = resolveAuthMap()[req.headers['x-tidemark-auth']] ?? null
  try { res.json(await vizActivity({ principal, after: req.query.after, limit: req.query.limit })) }
  catch (e) { console.error(JSON.stringify({ evt: 'viz_activity_error', msg: e?.message?.slice(0, 160) })); res.status(500).json({ ok: false, error: 'internal_error' }) }
})

// P0-08 forget：owner/admin HTTP 面（非 agent 工具，冻结 §12 五工具不变）。
// 鉴权 fail-closed：必须配 TIDEMARK_ADMIN_KEY（或显式 TIDEMARK_DEV_INSECURE=1 时收 'dev-admin'）
app.post('/admin/forget', async (req, res) => {
  const adminKey = process.env.TIDEMARK_ADMIN_KEY
    || (process.env.TIDEMARK_DEV_INSECURE === '1' ? 'dev-admin' : null)
  if (!adminKey || req.headers['x-tidemark-admin'] !== adminKey) {
    return res.status(403).json({ ok: false, error: 'admin_unauthorized' })
  }
  const { tenant_id, memory_id, reason } = req.body ?? {}
  try {
    const r = await forgetMemory({ tenantId: tenant_id, memoryId: memory_id, reason })
    res.status(r.ok ? 200 : 400).json(r)
  } catch (e) {
    console.error(JSON.stringify({ evt: 'forget_error', msg: e?.message?.slice(0, 160) }))
    res.status(500).json({ ok: false, error: 'internal_error' })
  }
})

app.post('/mcp', async (req, res) => {
  if (!req.rawHeaders || req.rawHeaders.length === 0) {   // serverless-http shim（本地无害）
    req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.flatMap(x => [k, x]) : [k, String(v)])
  }
  const principal = toolPrincipal(resolveAuthMap()[req.headers['x-tidemark-auth']] ?? null)
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
  server.tool('report_outcome',
    'settle an attempt: item-level attributions with evidence drive memory plasticity (outcome-gated). success=credited only, failure=blamed only, cancelled=none. attributions: max 32 items.',
    { outcome_request_id: z.string(), episode_id: z.string(), task_instance_id: z.string(), attempt_id: z.string(),
      status: z.enum(['success', 'failure', 'cancelled']),
      attributions: z.array(z.object({ recall_request_id: z.string(), receipt_item_id: z.string(), memory_id: z.string(),
        role: z.enum(['credited', 'blamed']), evidence_event_id: z.string() })).max(32).optional() },
    async (args) => asResult(await runToolResilient('report_outcome', () => reportOutcomeTool({ principal, ...args }))))
  server.tool('pin',
    'idempotent pin/unpin (capability-gated). Pin freezes CURRENT effective strength (materialize-then-set, never a boost); unpin resumes decay from now.',
    { memory_id: z.string(), pinned: z.boolean(), reason: z.string(), request_id: z.string() },
    async (args) => asResult(await runToolResilient('pin', () => pinTool({ principal, ...args }))))

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

export { app }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3901)
  app.listen(port, () => console.log(`tidemark-memory-mcp listening :${port}`))
}
