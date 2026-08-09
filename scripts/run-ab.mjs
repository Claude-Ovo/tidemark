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
const { runArm, ARMS } = await import('../src/ab/harness.mjs')

const tools = {
  remember: rememberTool, recall: recallTool,
  logEvent: logEventTool, reportOutcome: reportOutcomeTool,
}

const traces = new Map(ARMS.map(a => [a, []]))
const trace = (arm, obj) => traces.get(arm).push(obj)

console.log(`A/B run-key=${RUNKEY} seed=${SEED} tenant-base=${TENANT_BASE}（三臂同任务/同 seed/同 embedding；oracle=确定性哨兵匹配）`)
const summary = []
for (const arm of ARMS) {
  const r = await runArm({ arm, runKey: RUNKEY, tenantBase: TENANT_BASE, tools, seed: SEED, trace })
  summary.push(r)
  console.log(`  ${arm.padEnd(12)} score=${r.score}  probes=${r.probes}`)
}

mkdirSync(new URL('../traces/', import.meta.url), { recursive: true })
for (const arm of ARMS) {
  const p = fileURLToPath(new URL(`../traces/ab-${RUNKEY}-${arm}.jsonl`, import.meta.url))
  writeFileSync(p, traces.get(arm).map(x => JSON.stringify(x)).join('\n') + '\n')
}
console.log(`traces -> traces/ab-${RUNKEY}-{arm}.jsonl（content-free）`)
console.log(JSON.stringify({ run_key: RUNKEY, seed: SEED, summary: summary.map(s => ({ arm: s.arm, score: s.score })) }))
await getPool().end()
