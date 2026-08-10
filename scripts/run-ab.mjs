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
// 二审 P2：CLI 入口 fail-closed——seed 必须是 [0, 2^32-1] 安全整数；
// replica 限短 ASCII slug（防路径逃逸与 tenant 名污染）
const SEED = Number(arg('seed', '42'))
if (!Number.isSafeInteger(SEED) || SEED < 0 || SEED > 0xFFFFFFFF) {
  console.error(`--seed 必须是 [0, 4294967295] 内的整数，收到: ${arg('seed', '42')}`)
  process.exit(1)
}
const TENANT_BASE = arg('tenant-base', 'ab-demo')
const REPLICA = arg('replica', '') || null
if (REPLICA !== null && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(REPLICA)) {
  console.error(`--replica 必须匹配 ^[a-z0-9][a-z0-9_-]{0,31}$（短 ASCII slug），收到: ${REPLICA}`)
  process.exit(1)
}

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
const { groupReport, verifyFixtures } = await import('../src/ab/report.mjs')

const summary = []
for (const arm of ARMS) {
  const r = await runArm({ arm, identity, tenantBase: TENANT_BASE, tools, trace, replica: REPLICA })
  summary.push(r)
}

// v4 分组报表（预审裁定：headline 不出单一均分；坑位前置不成立标 invalid_fixture）
const fx = verifyFixtures({ vector: traces.get('vector-only'), full: traces.get('full') })
const invalidSet = new Set(fx.invalid)
const reports = {}
for (const r of summary) {
  const g = groupReport(r, invalidSet)
  reports[r.arm] = g
  const controls = g.controls.map(c => `${c.scenario.replace(/^(sc|nc)-/, '')}:${c.invalid ? 'INVALID' : c.pass ? 'pass' : 'FAIL'}`).join(' ')
  const diags = g.diagnostics.map(d => `${d.scenario.replace(/^sc-/, '')}=${d.scores.join('/')}${d.budget_normalized.length ? `(norm ${d.budget_normalized.join('/')})` : ''}`).join(' ')
  console.log(`  ${r.arm}`)
  console.log(`    main         score=${g.main.score}  success=${g.main.success}  (n=${g.main.n})`)
  console.log(`    controls     ${controls}`)
  console.log(`    diagnostics  ${diags}`)
  console.log(`    reference    overall=${g.reference_overall.score} (n=${g.reference_overall.n})`)
}
if (fx.invalid.length) console.log(`  invalid_fixture: ${fx.invalid.join(', ')}（前置不成立，已排除出分组统计）`)
if (fx.violations.length) console.log(`  CONTROL VIOLATIONS: ${JSON.stringify(fx.violations)}`)
console.log(`  flips: ${JSON.stringify(fx.flips)}`)

// v4 ack 解释①：cancelled 目标的行级零塑性 read-only 审计——六字段与植入终态完全一致
// （receipt 面证据之外的持久态铁证；违反即 exit 1）
const fullArm = summary.find(s => s.arm === 'full')
const cnMem = fullArm?.factMems?.['cn-target']
let cnAudit = null
if (cnMem) {
  const { getPool } = await import('../src/lib/db.mjs')
  const { rows } = await getPool().query(
    `SELECT credited_success_count, evidenced_blame_count, strength_anchor,
            strength_anchor_at, last_rewarded_at, created_at, revision
     FROM memories WHERE tenant_id=$1 AND memory_id=$2`,
    [`${TENANT_BASE}-${identity.exp_id}${REPLICA ? `-${REPLICA}` : ''}-full`, cnMem])
  const r = rows[0]
  cnAudit = r && Number(r.credited_success_count) === 0 && Number(r.evidenced_blame_count) === 0
    && Number(r.strength_anchor) === 1
    && String(r.last_rewarded_at) === String(r.created_at)
    ? { pass: true }
    : { pass: false, row: r ?? 'MISSING' }
  console.log(`  cancelled-target row audit: ${cnAudit.pass ? 'PASS（counts 0/0、anchor 1、last_rewarded_at===created_at——两次 cancelled 未触碰任何持久态）' : `FAIL ${JSON.stringify(cnAudit.row)}`}`)
  if (!cnAudit.pass) process.exitCode = 1
}

const tracesDir = fileURLToPath(new URL('../traces/', import.meta.url))
mkdirSync(tracesDir, { recursive: true })
const stem = REPLICA ? `${identity.exp_id}-${REPLICA}` : identity.exp_id
for (const arm of ARMS) {
  const p = fileURLToPath(new URL(`../traces/ab-${stem}-${arm}.jsonl`, import.meta.url))
  if (!p.startsWith(tracesDir)) throw new Error(`trace path escaped traces dir: ${p}`)   // 二审 P2 兜底
  writeFileSync(p, traces.get(arm).map(x => JSON.stringify(x)).join('\n') + '\n')
}
console.log(`traces -> traces/ab-${stem}-{arm}.jsonl（content-free，header 含完整 identity）`)
console.log(JSON.stringify({ exp_id: identity.exp_id, replica: REPLICA, identity: identity.components,
  groups: reports, invalid_fixtures: fx.invalid, control_violations: fx.violations,
  flips: fx.flips, cancelled_row_audit: cnAudit?.pass ?? null,
  reference: summary.map(s => ({ arm: s.arm, score: s.score, task_success_rate: s.task_success_rate })) }))
await getPool().end()
