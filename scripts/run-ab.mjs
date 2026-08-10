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
const { groupReport, verifyFixtures, expectedContentionScenarios } = await import('../src/ab/report.mjs')

// v4 三审 P1-2：cancelled 审计目标的 before 基线——afterPlant 钩子在【任何 probe 前】
// 冻结六字段快照；末尾逐字段与 after 精确对账（不用创建默认常量冒充 before）
const AUDIT_FIELDS = ['credited_success_count', 'evidenced_blame_count', 'strength_anchor',
  'strength_anchor_at', 'last_rewarded_at', 'revision']
const { getPool } = await import('../src/lib/db.mjs')
const rowSnapshot = async (tenantId, memoryId) => {
  const { rows } = await getPool().query(
    `SELECT ${AUDIT_FIELDS.join(', ')} FROM memories WHERE tenant_id=$1 AND memory_id=$2`,
    [tenantId, memoryId])
  return rows[0] ? Object.fromEntries(AUDIT_FIELDS.map(f => [f, String(rows[0][f])])) : null
}
let cnBaseline = null
const auditHooks = {
  afterPlant: async (factId, memoryId, principal) => {
    if (factId === 'cn-target') cnBaseline = { memoryId, tenant: principal.tenant_id,
      before: await rowSnapshot(principal.tenant_id, memoryId) }
  },
}

const summary = []
for (const arm of ARMS) {
  const r = await runArm({ arm, identity, tenantBase: TENANT_BASE, tools, trace, replica: REPLICA,
    hooks: arm === 'full' ? auditHooks : {} })
  summary.push(r)
}

// v4 分组报表（预审裁定：headline 不出单一均分；坑位前置不成立标 invalid_fixture——
// 期望场景集合从 identity.suite 冻结，缺 trace fail-closed）
const fx = verifyFixtures({ vector: traces.get('vector-only'), full: traces.get('full'),
  expected: expectedContentionScenarios(identity.suite.scenarios) })
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

// v4 三审 P1-2：cancelled 目标行级审计 = before/after 六字段【逐字段精确相等】
// （before 在 plant 后任何 probe 前冻结；revision/strength_anchor_at 也在对账内——
// cancelled 若偷偷 bump revision 或重写锚点，此处必 FAIL exit 1）
let cnAudit = null
if (cnBaseline) {
  const after = await rowSnapshot(cnBaseline.tenant, cnBaseline.memoryId)
  if (!cnBaseline.before || !after) {
    cnAudit = { pass: false, reason: 'row missing', before: cnBaseline.before, after }
  } else {
    const diffs = AUDIT_FIELDS.filter(f => cnBaseline.before[f] !== after[f])
    cnAudit = diffs.length === 0
      ? { pass: true }
      : { pass: false, diffs: Object.fromEntries(diffs.map(f => [f, { before: cnBaseline.before[f], after: after[f] }])) }
  }
  console.log(`  cancelled-target row audit: ${cnAudit.pass
    ? 'PASS（before/after 六字段逐字段相等——两次 cancelled 未触碰任何持久态，含 revision 与锚点时间）'
    : `FAIL ${JSON.stringify(cnAudit)}`}`)
  if (!cnAudit.pass) process.exitCode = 1
} else {
  console.log('  cancelled-target row audit: SKIPPED（cn-target 未在本 run 植入）')
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
