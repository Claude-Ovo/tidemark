// P0-11 demo refresh（DESIGN-OCEAN.md「Demo refresh 契约」+ Codex activity 二审修订）：
// 只走正常 remember / recall / log_event / report_outcome / pin 路径。禁 UPDATE、禁伪造时间。
//
// 两阶段养成（Codex 校准裁决 a' + 二审时间模型修正）：
//   --phase=seed      初次播种：remember + pin。之后让它自然衰减几天 → 真实 Receding 基线。
//   --phase=finalize  录制前一次性：再 remember 一小批 fresh（finalize 语料，计入 preflight），
//                     锁其中未 pin 一条做两次 blamed（1.0→0.8→0.64 落 Active，断言 0.35<after<0.70）；
//                     旧 seed（已自然衰减）只作 Receding 基线与 credited 候选（spacing 足 → gain>0）。
//                     ※ 不 blame 旧 seed——衰减后 0.1969 再 blamed 是 0.1260，掉 fade 区不是 Active
//                     （Codex 二审 P1-2 实库测算）。
//   默认 --phase=all（开发演练，seed+finalize 连跑）——演练配 --agent=disposable-xxx。
// 单一真相源（二审 truth-source 修正）：所有 effective/preview/occupancy 全部消费只读
// vizOcean 服务端快照（与 recall 同一 decayEffective），本脚本零本地衰减公式。
// 塑性断言：applied=true 且 blamed after<before（终轮加 Active 带断言）/ credited gain>0 且
// after>before，任何一条不成立 exit 1——"applied"不冒充"迁移"。
// 运行：node scripts/demo-refresh.mjs [--tenant=demo-tenant] [--agent=demo-agent] [--phase=all|seed|finalize]
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
// 真向量（local-onnx，prod 同款）：stub 是整文 sha256 零语义，semantic_gate 0.55 会把注入全挡死
process.env.EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'local-onnx'
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'
process.env.TIDEMARK_DEV_INSECURE = process.env.TIDEMARK_DEV_INSECURE || '1'

const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? dflt
const TENANT = arg('tenant', 'demo-tenant')
const AGENT = arg('agent', 'demo-agent')
const PHASE = arg('phase', 'all')
if (!['all', 'seed', 'finalize'].includes(PHASE)) { console.error(`invalid --phase=${PHASE}`); process.exit(1) }

const { rememberTool } = await import('../src/tools/remember.mjs')
const { recallTool } = await import('../src/tools/recall.mjs')
const { logEventTool } = await import('../src/tools/log-event.mjs')
const { reportOutcomeTool } = await import('../src/tools/report-outcome.mjs')
const { pinTool } = await import('../src/tools/pin.mjs')
const { getPool } = await import('../src/lib/db.mjs')
const { vizOcean } = await import('../src/viz/ocean.mjs')

const principal = { tenant_id: TENANT, agent_id: AGENT, capabilities: ['memory:pin'] }
const run = randomUUID().slice(0, 8)
const ep = (n) => `demo-${run}-ep${n}`
const die = (label, r) => { if (!r?.ok) { console.error(`FAIL ${label}:`, JSON.stringify(r).slice(0, 400)); process.exit(1) } return r }
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1) }

// 单一真相源：只读服务端快照（同一 decayEffective、同一 snapshot_at）
const snap = die('viz-ocean-preflight', await vizOcean({ principal }))
const rows = [...snap.episodes.flatMap(e => e.memories), ...snap.loose]
const ANCHOR_MIN = 0.70, ANCHOR_CAPACITY = 28   // 容量为 layout 实测保守值
const seedAdd = PHASE !== 'finalize' ? 8 : 0
const finAdd = PHASE !== 'seed' ? 4 : 0          // finalize 语料也计入 preflight（二审修正）
const anchorProjected = rows.filter(r => r.pinned || r.effective_strength >= ANCHOR_MIN).length + seedAdd + finAdd
if (anchorProjected > ANCHOR_CAPACITY) {
  fail(`occupancy preflight: anchor 带投影 ${anchorProjected} > 容量 ${ANCHOR_CAPACITY}——拒绝往拥挤池灌数据。换 --agent= 干净 agent，或等自然衰减`)
}
console.log(`demo refresh run=${run} tenant=${TENANT} agent=${AGENT} phase=${PHASE}（快照 ${snap.snapshot_at}：${rows.length} 条，anchor 投影 ${anchorProjected}/${ANCHOR_CAPACITY}）`)

const SEED = [
  ['fact', '用户 Chen 的订单 #8821 已升级为加急配送，承诺 48 小时内送达'],
  ['fact', '用户偏好邮件联系，工作时间 UTC+8 上午，不接电话'],
  ['decision', '对超过 30 天的退货申请，先查扩展保修再拒绝——上次直接拒绝被投诉'],
  ['fact', '仓库 B 的库存同步有 15 分钟延迟，缺货判断要留缓冲'],
  ['observation', '连续三位用户反馈结账页在 Safari 上白屏，已上报前端组'],
  ['fact', '公司退款政策 2026-08 修订：数字商品 7 天无理由，实体 30 天'],
  ['decision', '高价值客户（LTV>5000）的工单优先人工复核，不走自动回复'],
  ['observation', '周一上午的工单量是平日两倍，回复模板要提前备好'],
]
// finalize 语料与 seed 完全不同——避免同语料副本抢 rerank（污染样本教训）
const FINALIZE = [
  ['observation', '今晨支付网关升级后，Apple Pay 回调延迟从 2 秒涨到 11 秒'],
  ['fact', '新版会员体系今天上线：银卡满 500 积分自动升金卡'],
  ['decision', '疑似盗刷工单一律先冻结订单再人工核验，不先联系持卡人'],
  ['fact', '客服值班表调整：周五晚班由 B 组接管，交接时间 18:00'],
]
const BLAME_IDX = 2   // finalize 语料中的盗刷决策——blamed 锁这条（未 pin）
const BLAME_QUERY = '疑似盗刷工单 冻结订单 人工核验'   // 近原文措辞——onnx 中文向量下短关键词串排不进 top-5

const remember = async (corpus, episode) => {
  const ids = []
  for (let i = 0; i < corpus.length; i++) {
    const [kind, content] = corpus[i]
    const r = die(`remember#${i}`, await rememberTool({
      principal, content, kind, episode_id: episode, request_id: randomUUID(),
      importance: 0.5 + (i % 4) * 0.1,
    }))
    ids.push(r.memory_id)
  }
  return ids
}

if (PHASE !== 'finalize') {
  const seedIds = await remember(SEED, ep('seed'))
  console.log(`seed remember x${seedIds.length} -> anchor band`)
  const pinnedNow = rows.filter(r => r.pinned).length
  const pinN = Math.min(2, Math.max(0, 4 - pinnedNow))   // 二审 P2：守卫要真实，3 时只补 1
  for (const id of seedIds.slice(0, pinN)) {
    die('pin', await pinTool({ principal, memory_id: id, pinned: true, reason: 'demo-core-policy', request_id: randomUUID() }))
  }
  console.log(pinN ? `pin x${pinN} -> pin ring` : `pin skipped（已有 ${pinnedNow}）`)
}
if (PHASE === 'seed') { console.log('seed 完成。让它衰减几天，录制前跑 --phase=finalize'); await getPool().end(); process.exit(0) }

// finalize：新 fresh 批（时间模型正确的 blamed 目标——1.0 起点，不拿衰减旧 seed 冒充）
const finIds = await remember(FINALIZE, ep('fin'))
console.log(`finalize remember x${finIds.length} -> anchor band`)
const blameTarget = finIds[BLAME_IDX]

const evidenceRound = async ({ query, episode, role, status, targetId }) => {
  const attempt = randomUUID(), task = randomUUID()
  const rec = die('recall', await recallTool({
    principal, query, purpose: 'demo evidence round', episode_id: episode,
    attempt_id: attempt, request_id: randomUUID(),
  }))
  const rrId = rec.receipt.request_id
  const item = (rec.receipt?.items ?? []).find(i => i.injected && i.memory_id === targetId)
  if (!item) fail(`${role} 目标 ${targetId.slice(0, 8)} 未被 recall 注入（query="${query}"）——不静默换目标`)
  const evid = die('log_event', await logEventTool({
    principal, episode_id: episode, task_instance_id: task, attempt_id: attempt,
    event_type: 'memory_used', request_id: randomUUID(),
    payload: { recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: item.memory_id },
  }))
  const out = die('report_outcome', await reportOutcomeTool({
    principal, outcome_request_id: randomUUID(), episode_id: episode,
    task_instance_id: task, attempt_id: attempt, status,
    attributions: [{
      recall_request_id: rrId, receipt_item_id: item.receipt_item_id,
      memory_id: item.memory_id, role, evidence_event_id: evid.event_id,
    }],
  }))
  const it = out.items.find(i => i.memory_id === targetId)
  if (!it || it.applied !== true) fail(`${role} item 未 applied（reason=${it?.reason}）`)
  const p = it.plasticity
  if (role === 'blamed' && !(p && p.strength_anchor_after < p.effective_before)) {
    fail(`blamed 无实际下移：before=${p?.effective_before} after=${p?.strength_anchor_after}`)
  }
  if (role === 'credited' && !(p && p.reinforcement_gain > 0 && p.strength_anchor_after > p.effective_before)) {
    fail(`credited 无实际上浮：gain=${p?.reinforcement_gain} before=${p?.effective_before} after=${p?.strength_anchor_after}`)
  }
  console.log(`  ${role} ${targetId.slice(0, 8)}: ${p.effective_before} -> ${p.strength_anchor_after}${p.reinforcement_gain != null ? ` (gain ${p.reinforcement_gain})` : ''}`)
  return p
}

// blamed ×2 锁 finalize fresh：1.0 → 0.8 → 0.64，终轮断言真的落在 Active 带
console.log('blamed rounds（锁定 finalize fresh，断言穿进 Active）:')
let lastP = null
for (let round = 0; round < 2; round++) {
  lastP = await evidenceRound({ query: BLAME_QUERY, episode: ep(`blame${round}`), role: 'blamed', status: 'failure', targetId: blameTarget })
}
if (!(lastP.strength_anchor_after > 0.35 && lastP.strength_anchor_after < ANCHOR_MIN)) {
  fail(`blamed 终态 ${lastP.strength_anchor_after} 不在 Active 带 (0.35, 0.70)——时间模型错误，不得宣称穿层`)
}
console.log(`  -> Active 带断言通过（${lastP.strength_anchor_after}）`)

// credited 锁一条旧记忆（服务端快照选材：未 pin、effective 0.05~0.5——衰减后的 seed 正是候选）
const oldRows = rows
  .filter(r => !r.pinned && r.effective_strength < 0.5 && r.effective_strength > 0.05)
  .sort((a, b) => a.effective_strength - b.effective_strength)
if (oldRows.length) {
  const credTarget = oldRows[Math.floor(oldRows.length / 2)]
  console.log('credited round（锁定旧记忆，断言 gain>0）:')
  await evidenceRound({
    query: credTarget.content_preview.slice(0, 40), episode: ep('credit'),
    role: 'credited', status: 'success', targetId: credTarget.memory_id,
  })
  console.log(`done. run=${run}：blamed ×2 穿进 Active + credited 上浮全部实证`)
} else {
  console.log(`done（credited SKIPPED：无 effective 0.05~0.5 的旧记忆——fresh agent 无衰减历史，等 seed 衰减后跑 --phase=finalize）。run=${run}：blamed ×2 穿进 Active 已实证`)
}
await getPool().end()
