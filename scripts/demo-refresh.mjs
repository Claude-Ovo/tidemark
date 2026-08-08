// P0-11 demo refresh（DESIGN-OCEAN.md「Demo refresh 契约」+ Codex activity 一审 P1-3 修订）：
// 只走正常 remember / recall / log_event / report_outcome / pin 路径。禁 UPDATE、禁伪造时间。
//
// 两阶段养成（Codex 校准裁决 a'）：
//   --phase=seed      初次播种：remember + pin。之后让它自然衰减几天形成 Receding 基线。
//   --phase=finalize  录制前一次性：blamed/credited 证据链形成 Active 与迁移事件。
//   默认 --phase=all（开发演练用，seed+finalize 连跑）——演练请配 --agent=disposable-xxx，
//   final demo agent 只 seed 一次、finalize 一次，不反复 refresh。
// 目标锁定与塑性断言（P1-3）：
//   blamed 锁 seed 集中的指定未 pin 记忆，recall 未注入该条 = 硬失败退出非零；
//   credited 从只读 snapshot 选一条旧、未 pin、低 effective 的记忆并锁 ID；
//   每轮断言 response item applied=true 且 blamed after<before / credited gain>0 && after>before，
//   任何一条不成立即 exit 1——"outcome applied"不冒充"发生迁移"。
// occupancy preflight：anchor 带投影超容量直接拒绝，不往拥挤池里灌。
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
const { getPool, inSerializableTx } = await import('../src/lib/db.mjs')

const principal = { tenant_id: TENANT, agent_id: AGENT, capabilities: ['memory:pin'] }
const run = randomUUID().slice(0, 8)
const ep = (n) => `demo-${run}-ep${n}`
const die = (label, r) => { if (!r?.ok) { console.error(`FAIL ${label}:`, JSON.stringify(r).slice(0, 400)); process.exit(1) } return r }
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1) }

// 只读 preflight / 选材（读不是突变；写仍全走工具路径）
const snapshotRows = () => inSerializableTx(async (c) => (await c.query(
  `SELECT memory_id, pinned, layer, strength_anchor, strength_anchor_at, half_life_hours,
          left(content, 80) AS preview, created_at
   FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND admission='accepted'`,
  [TENANT, AGENT])).rows, 'demo-preflight')
const effectiveOf = (r, nowMs) =>
  Number(r.strength_anchor) * Math.exp(-Math.LN2 * ((nowMs - new Date(r.strength_anchor_at).getTime()) / 3600e3) / Number(r.half_life_hours))

const ANCHOR_CAPACITY = 28   // 内环 angle-only 容量的保守值（layout 实测 ~27 同半径可布）
const rows = await snapshotRows()
const nowMs = Date.now()
const anchorProjected = rows.filter(r => r.pinned || effectiveOf(r, nowMs) >= 0.7).length + (PHASE !== 'finalize' ? 8 : 0)
// 容量门只拦会增加 anchor 的阶段（finalize 只做塑性，anchor 只降不升）
if (PHASE !== 'finalize' && anchorProjected > ANCHOR_CAPACITY) {
  fail(`occupancy preflight: anchor 带投影 ${anchorProjected} > 容量 ${ANCHOR_CAPACITY}——拒绝往拥挤池灌数据。换 --agent= 干净 agent，或等自然衰减`)
}
console.log(`demo refresh run=${run} tenant=${TENANT} agent=${AGENT} phase=${PHASE}（现存 ${rows.length} 条，anchor 投影 ${anchorProjected}/${ANCHOR_CAPACITY}）`)

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
const BLAME_IDX = 4   // Safari 白屏——blamed 锁这条（未 pin）
const BLAME_QUERY = '结账页 Safari 白屏 前端'

let fresh = []
if (PHASE !== 'finalize') {
  for (let i = 0; i < FRESH.length; i++) {
    const [kind, content] = FRESH[i]
    const r = die(`remember#${i}`, await rememberTool({
      principal, content, kind, episode_id: ep('seed'), request_id: randomUUID(),
      importance: 0.5 + (i % 4) * 0.1,
    }))
    fresh.push(r.memory_id)
  }
  console.log(`remember x${fresh.length} -> anchor band`)
  const pinnedNow = rows.filter(r => r.pinned).length
  if (pinnedNow < 4) {
    for (const id of fresh.slice(0, 2)) {
      die('pin', await pinTool({ principal, memory_id: id, pinned: true, reason: 'demo-core-policy', request_id: randomUUID() }))
    }
    console.log('pin x2 -> pin ring')
  } else console.log(`pin skipped（已有 ${pinnedNow}）`)
}
if (PHASE === 'seed') { console.log('seed 完成。让它衰减几天，录制前跑 --phase=finalize'); await getPool().end(); process.exit(0) }

// finalize 阶段需要 seed 目标：all 用本轮 fresh；纯 finalize 从库里找 seed 语料（按内容前缀匹配）
if (PHASE === 'finalize') {
  // 污染样本可能有同语料多副本（多轮 seed）——挑 effective 最高的那份（rerank 最可能注入它）；
  // 仍锁定 ID、未注入照样硬失败，不静默换目标
  const seedRows = rows.filter(r => !r.pinned && r.preview.startsWith(FRESH[BLAME_IDX][1].slice(0, 20)))
    .sort((a, b) => effectiveOf(b, nowMs) - effectiveOf(a, nowMs))
  if (!seedRows.length) fail('finalize 找不到 seed 阶段的 blamed 目标（先跑 --phase=seed）')
  fresh = [null, null, null, null, seedRows[0].memory_id]
}
const blameTarget = PHASE === 'finalize' ? fresh[4] : fresh[BLAME_IDX]

// 一次完整证据链：recall → memory_used → report_outcome。targetId 必须被注入，否则硬失败
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
  // P1-3 核心：塑性 delta 断言——"applied"不冒充"迁移"
  if (!it || it.applied !== true) fail(`${role} item 未 applied（reason=${it?.reason}）`)
  const p = it.plasticity
  if (role === 'blamed' && !(p && p.strength_anchor_after < p.effective_before)) {
    fail(`blamed 无实际下移：before=${p?.effective_before} after=${p?.strength_anchor_after}`)
  }
  if (role === 'credited' && !(p && p.reinforcement_gain > 0 && p.strength_anchor_after > p.effective_before)) {
    fail(`credited 无实际上浮：gain=${p?.reinforcement_gain} before=${p?.effective_before} after=${p?.strength_anchor_after}`)
  }
  console.log(`  ${role} ${targetId.slice(0, 8)}: ${p.effective_before} -> ${p.strength_anchor_after}${p.reinforcement_gain != null ? ` (gain ${p.reinforcement_gain})` : ''}`)
  return true
}

// blamed ×2 锁同一条：1.0 → 0.8 → 0.64 穿进 Active 带
console.log('blamed rounds（锁定目标，断言下移）:')
for (let round = 0; round < 2; round++) {
  await evidenceRound({ query: BLAME_QUERY, episode: ep(`blame${round}`), role: 'blamed', status: 'failure', targetId: blameTarget })
}

// credited 锁一条旧、未 pin、低 effective 的记忆（快照只读选材），query 取其 preview
const oldRows = rows
  .filter(r => !r.pinned && r.layer !== 'experience' && effectiveOf(r, nowMs) < 0.5 && effectiveOf(r, nowMs) > 0.05)
  .sort((a, b) => effectiveOf(a, nowMs) - effectiveOf(b, nowMs))
if (oldRows.length) {
  const credTarget = oldRows[Math.floor(oldRows.length / 2)]
  console.log('credited round（锁定旧记忆，断言 gain>0）:')
  await evidenceRound({
    query: credTarget.preview.slice(0, 40), episode: ep('credit'),
    role: 'credited', status: 'success', targetId: credTarget.memory_id,
  })
  console.log(`done. run=${run}：blamed ×2 穿层 + credited 上浮全部实证。/pool.html 看分层，/viz/activity 含本轮事件`)
} else {
  // 显式跳过而非硬失败：新 agent 没有陈年记忆，spacing≈0 时 credited 物理上零增益——
  // 这正是 a' 两阶段存在的理由（seed 后要等真实衰减），不打成功日志
  console.log(`done（credited SKIPPED：无 effective 0.05~0.5 的旧记忆——fresh agent 的 spacing≈0 无法演上浮，等 seed 衰减后跑 --phase=finalize）。run=${run}：blamed ×2 穿层已实证`)
}
await getPool().end()
