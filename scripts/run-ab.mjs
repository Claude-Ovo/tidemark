// P0-12 三臂 A/B 入口：node scripts/run-ab.mjs [--seed=42] [--tenant-base=ab-demo] [--replica=r1]
// 实验身份 = canonical experiment identity（suite+语料+seed+embedding+召回配置全量摘要）——
// 同身份重跑走幂等 replay；换 seed/语料/embedding/top-k 即新身份新 tenant。
// --replica 是显式的【非科学身份】：只做 tenant namespace（同配置 fresh-run determinism 判别用），
// 不进入 exp_id（一审 P1-3 裁定，旧 --run-key 已删除）。
// 产出：1) 汇总表（stdout）  2) 公开脱敏 trace：traces/ab-<exp_id>[-replica]-<arm>.jsonl（content-free）
// Codex 硬闸声明：本入口与 harness/policy/oracle 零 viz 依赖，画面永不进指标。
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'local-onnx'   // 三臂同 embedding（契约）
process.env.TIDEMARK_DEV_INSECURE = process.env.TIDEMARK_DEV_INSECURE || '1'
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'

const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? dflt
const SEED = Number(arg('seed', '42'))
const TENANT_BASE = arg('tenant-base', 'ab-demo')
const REPLICA = arg('replica', '') || null

const { rememberTool } = await import('../src/tools/remember.mjs')
const { recallTool } = await import('../src/tools/recall.mjs')
const { logEventTool } = await import('../src/tools/log-event.mjs')
const { reportOutcomeTool } = await import('../src/tools/report-outcome.mjs')
const { getPool } = await import('../src/lib/db.mjs')
const { runArm, ARMS, experimentIdentity } = await import('../src/ab/harness.mjs')
const { embedModelId } = await import('../src/lib/embed.mjs')
const { CFG: RECALL_CFG } = await import('../src/lib/recall-config.mjs')

const tools = {
  remember: rememberTool, recall: recallTool,
  logEvent: logEventTool, reportOutcome: reportOutcomeTool,
}

const traces = new Map(ARMS.map(a => [a, []]))
const trace = (arm, obj) => traces.get(arm).push(obj)

const identity = experimentIdentity({ seed: SEED, embeddingId: embedModelId(), recallCfg: RECALL_CFG })
console.log(`A/B exp_id=${identity.exp_id} seed=${SEED}${REPLICA ? ` replica=${REPLICA}（非科学身份，仅 tenant namespace）` : ''}（agent_policy=deterministic-v1, model=null；指标=injection hit / lifecycle ablation）`)
console.log(`  identity: ${JSON.stringify(identity.components)}`)
const summary = []
for (const arm of ARMS) {
  const r = await runArm({ arm, identity, tenantBase: TENANT_BASE, tools, seed: SEED, trace, replica: REPLICA })
  summary.push(r)
  console.log(`  ${arm.padEnd(12)} score=${r.score}  task_success=${r.task_success_rate}  probes=${r.probes}`)
}

mkdirSync(new URL('../traces/', import.meta.url), { recursive: true })
const stem = REPLICA ? `${identity.exp_id}-${REPLICA}` : identity.exp_id
for (const arm of ARMS) {
  const p = fileURLToPath(new URL(`../traces/ab-${stem}-${arm}.jsonl`, import.meta.url))
  writeFileSync(p, traces.get(arm).map(x => JSON.stringify(x)).join('\n') + '\n')
}
console.log(`traces -> traces/ab-${stem}-{arm}.jsonl（content-free，header 含完整 identity）`)
console.log(JSON.stringify({ exp_id: identity.exp_id, replica: REPLICA, identity: identity.components,
  summary: summary.map(s => ({ arm: s.arm, score: s.score, task_success_rate: s.task_success_rate })) }))
await getPool().end()
