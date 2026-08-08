// P0-11 demo refresh（DESIGN-OCEAN.md「Demo refresh 契约」，Codex 三审裁决 b / 四审 GO）：
// 只走正常 remember / recall / log_event / report_outcome / pin 路径重灌演示数据。
// 禁止直接 UPDATE strength/created_at，禁止伪造时间——分层全部由真实塑性形成：
//   Anchor：新鲜 remember（anchor=1.0 未衰减）+ pin 两条进小环
//   Active：合法证据链的 blamed（fresh 1.0 ×0.8^n 掉到 0.35~0.70 带）
//   Receding：既有旧记忆不动（它们真实衰减到了那里——0/3/71 是系统在工作的证据）
//   迁移事件：credited/blamed outcome 落 outcomes 表 → /viz/activity 自然吐出
// 可重复：每次运行生成新 episode 前缀，不清旧数据（遗忘由系统自己完成）。
// 运行：node scripts/demo-refresh.mjs（自装 .env，锁 stub embedding 与 dev 键语义一致）
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
// 真向量（local-onnx，prod 同款）：stub 是整文 sha256 零语义，semantic_gate 0.55 会把
// recall 注入全挡死——demo 的证据链必须真实检索命中
process.env.EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'local-onnx'
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'
process.env.TIDEMARK_DEV_INSECURE = process.env.TIDEMARK_DEV_INSECURE || '1'  // 本地 demo 刷新（与 dev server 同语义）

const { rememberTool } = await import('../src/tools/remember.mjs')
const { recallTool } = await import('../src/tools/recall.mjs')
const { logEventTool } = await import('../src/tools/log-event.mjs')
const { reportOutcomeTool } = await import('../src/tools/report-outcome.mjs')
const { pinTool } = await import('../src/tools/pin.mjs')
const { getPool } = await import('../src/lib/db.mjs')

const principal = { tenant_id: 'demo-tenant', agent_id: 'demo-agent', capabilities: ['memory:pin'] }
const run = randomUUID().slice(0, 8)                 // 每次刷新独立 episode 前缀，天然可重复
const ep = (n) => `demo-${run}-ep${n}`
const die = (label, r) => { if (!r?.ok) { console.error(`FAIL ${label}:`, r); process.exit(1) } return r }

// 演示语料：一个客服 agent 的记忆面（内容真实成文，评委 hover 时读得通）
const FRESH = [
  ['fact', '用户 Chen 的订单 #8821 已升级为加急配送，承诺 48 小时内送达'],
  ['fact', '用户偏好邮件联系，工作时间 UTC+8 上午，不接电话'],
  ['decision', '对超过 30 天的退货申请，先查扩展保修再拒绝——上次直接拒绝被投诉'],
  ['fact', '仓库 B 的库存同步有 15 分钟延迟，缺货判断要留缓冲'],
  ['observation', '连续三位用户反馈结账页在 Safari 上白屏，已上报前端组'],
  ['fact', '公司退款政策 2026-08 修订：数字商品 7 天无理由，实体 30 天'],
  ['decision', '高价值客户（LTV>5000）的工单优先人工复核，不走自动回复'],
  ['observation', '周一上午的工单量是平日两倍，回复模板要提前备好'],
]

console.log(`demo refresh run=${run}`)

// 1) 新鲜记忆 → Anchor 带（anchor=1.0，零衰减）
const fresh = []
for (let i = 0; i < FRESH.length; i++) {
  const [kind, content] = FRESH[i]
  const r = die(`remember#${i}`, await rememberTool({
    principal, content, kind, episode_id: ep('seed'), request_id: randomUUID(),
    importance: 0.5 + (i % 4) * 0.1,
  }))
  fresh.push(r.memory_id)
}
console.log(`remember x${fresh.length} -> anchor band`)

// 2) pin 两条 → 锚定小环（pin 是 capability 路径，进 tool_requests 审计）。
// 只读守卫防重复运行累积：已有 >=4 个 pinned 就不再加（读不是突变，写仍全走工具路径）
const { inSerializableTx } = await import('../src/lib/db.mjs')
const pinnedNow = await inSerializableTx(async (c) => Number((await c.query(
  `SELECT count(*)::INT AS n FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND pinned AND admission='accepted'`,
  [principal.tenant_id, principal.agent_id])).rows[0].n), 'demo-pin-count')
if (pinnedNow < 4) {
  for (const id of fresh.slice(0, 2)) {
    die('pin', await pinTool({ principal, memory_id: id, pinned: true, reason: 'demo-core-policy', request_id: randomUUID() }))
  }
  console.log('pin x2 -> pin ring')
} else {
  console.log(`pin skipped（已有 ${pinnedNow} 个 pinned，防重复运行累积）`)
}

// 一次完整证据链：recall → memory_used → report_outcome（credited 或 blamed）
const evidenceRound = async ({ query, episode, role, status, preferId = null }) => {
  const attempt = randomUUID(), task = randomUUID()
  const rec = die('recall', await recallTool({
    principal, query, purpose: 'demo evidence round', episode_id: episode,
    attempt_id: attempt, request_id: randomUUID(),
  }))
  const rrId = rec.receipt.request_id
  const items = rec.receipt?.items?.filter(i => i.injected) ?? []
  if (!items.length) { console.log(`  (recall "${query.slice(0, 18)}…" 无注入项，跳过)`); return }
  // 多轮塑性要作用在同一条记忆上才能穿层——优先选上一轮命中的那条（仍以真实注入为前提）
  const item = (preferId && items.find(i => i.memory_id === preferId)) || items[0]
  const evid = die('log_event', await logEventTool({
    principal, episode_id: episode, task_instance_id: task, attempt_id: attempt,
    event_type: 'memory_used', request_id: randomUUID(),
    payload: { recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: item.memory_id },
  }))
  die('report_outcome', await reportOutcomeTool({
    principal, outcome_request_id: randomUUID(), episode_id: episode,
    task_instance_id: task, attempt_id: attempt, status,
    attributions: [{
      recall_request_id: rrId, receipt_item_id: item.receipt_item_id,
      memory_id: item.memory_id, role, evidence_event_id: evid.event_id,
    }],
  }))
  return item.memory_id
}

// 3) blamed 证据链 ×2 轮 → 新鲜记忆 1.0 → 0.8 → 0.64 掉进 Active 带（合法塑性，非伪造）
console.log('blamed rounds -> active band:')
let blameTarget = null
for (let round = 0; round < 2; round++) {
  const hit = await evidenceRound({
    query: '结账页 Safari 白屏 前端', episode: ep(`blame${round}`), role: 'blamed', status: 'failure',
    preferId: blameTarget,
  })
  if (hit) { blameTarget = hit; console.log(`  blamed round${round + 1} -> ${hit.slice(0, 8)}`) }
}

// 4) credited 证据链 → 老的低保留记忆被拉回（credited 上浮的活证据；受 spacing 限制天然缓慢）
console.log('credited rounds -> upward migration:')
for (const query of ['退货 保修 政策', '订单 配送 加急']) {
  const hit = await evidenceRound({ query, episode: ep('credit'), role: 'credited', status: 'success' })
  if (hit) console.log(`  credited -> ${hit.slice(0, 8)}`)
}

console.log(`done. 打开 /pool.html 看分层，/viz/activity 应含本轮 remember/recall/outcome 事件（run=${run}）`)
await getPool().end()
