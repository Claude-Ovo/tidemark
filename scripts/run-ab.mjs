// P0-12 三臂 A/B 入口：node scripts/run-ab.mjs [--run-key=ab-v1] [--seed=42] [--tenant-base=ab-demo]
// 三臂各自独立 tenant；确定性 ID（同 run-key 重跑走幂等 replay）；产出：
//   1) 汇总表（stdout）  2) 公开脱敏 trace：traces/ab-<runkey>-<arm>.jsonl（content-free）
// Codex 硬闸声明：本入口与 harness/oracle 零 viz 依赖，画面永不进指标。
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'local-onnx'   // 三臂同 embedding（契约）
process.env.TIDEMARK_DEV_INSECURE = process.env.TIDEMARK_DEV_INSECURE || '1'
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'

const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? dflt
const RUNKEY = arg('run-key', 'ab-v1')
const SEED = Number(arg('seed', '42'))
const TENANT_BASE = arg('tenant-base', 'ab-demo')

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

// canonical experiment identity（预审 P1-2）：seed/语料/embedding/召回配置任一变化 = 新身份新 tenant
const identity = experimentIdentity({ seed: SEED, embeddingId: embedModelId(), recallCfg: RECALL_CFG })
console.log(`A/B exp_id=${identity.exp_id} seed=${SEED}（agent_policy=deterministic-v1, model=null；指标=injection hit / lifecycle ablation）`)
console.log(`  identity: ${JSON.stringify(identity.components)}`)
const summary = []
for (const arm of ARMS) {
  const r = await runArm({ arm, identity, tenantBase: TENANT_BASE, tools, seed: SEED, trace })
  summary.push(r)
  console.log(`  ${arm.padEnd(12)} score=${r.score}  task_success=${r.task_success_rate}  probes=${r.probes}`)
}

mkdirSync(new URL('../traces/', import.meta.url), { recursive: true })
for (const arm of ARMS) {
  const p = fileURLToPath(new URL(`../traces/ab-${identity.exp_id}-${arm}.jsonl`, import.meta.url))
  writeFileSync(p, traces.get(arm).map(x => JSON.stringify(x)).join('\n') + '\n')
}
console.log(`traces -> traces/ab-${identity.exp_id}-{arm}.jsonl（content-free，header 含完整 identity）`)
console.log(JSON.stringify({ exp_id: identity.exp_id, identity: identity.components,
  summary: summary.map(s => ({ arm: s.arm, score: s.score, task_success_rate: s.task_success_rate })) }))
await getPool().end()
