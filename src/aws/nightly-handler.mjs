// P0-09 夜间 Lambda 入口：EventBridge 定时规则 -> 本 handler -> per-tenant runNightly。
// scheduled_for 规范化（结论 13：取 EventBridge 规范计划时间）：event.time 向下取整到分钟——
// 同一次计划触发的重试/重复投递携带同一 event.time，规范化后落进同一个 run key
// (tenant, job_kind, scheduled_for, pipeline_version)，nightly_runs 唯一键保证只提交一次；
// 手动测试可传 {"scheduled_for": "<ISO>"} 覆盖。
//
// 失败语义（round-2 修 P0-2，round-3 修 P1：黑名单翻【终态白名单】——未知/畸形默认 reject）。
// 冻结 allowlist：
// - TERMINAL（可成功返回）：completed / no_work / already_completed / failed / failed_terminal
//  ——failed 是诚实终态（orchestrator 已按 degraded 语义处理），如实标注不触发重试风暴。
// - 其余一切（retryable / stale / lease_held / refused_future_evaluation / crashed、
//   将来新增的任何状态、拼写漂移、缺失 job、畸形结果）都判 pending -> 整次 invoke 失败：
//   Lambda 异步重试携带【同一 event】-> 同 canonical scheduled_for -> 按原 run key takeover。
//   次日是新 run key，吞掉非终态 = 旧 run 永远无人收口；fail-open 的方向必须是 reject。
// - 拓扑校验：top 必须是三个已知 orchestrator 形状之一；dream 永远必须在场；
//   非 short_circuited 形状下 reflection/transition 也必须在场（short_circuited 合法缺席）。
// 所有 tenant 先尽力跑完（不因首个 tenant 非终态放弃其余），最后统一裁决。
// 意外异常按 crashed 计入该 tenant，同样导致整次失败 -> retry/DLQ 接手（结论 13）。
import { bootstrapSecrets } from '../lib/secrets.mjs'

const TERMINAL = new Set(['completed', 'no_work', 'already_completed', 'failed', 'failed_terminal'])
const KNOWN_TOPS = new Set(['completed', 'completed_degraded', 'short_circuited_at_dream'])

const canonicalScheduledFor = (event) => {
  const raw = event?.scheduled_for ?? event?.time
  if (!raw) throw new Error('event must carry time (EventBridge) or scheduled_for (manual)')
  const t = new Date(raw)
  if (Number.isNaN(t.getTime())) throw new Error(`unparseable schedule time: ${String(raw).slice(0, 40)}`)
  t.setUTCSeconds(0, 0)
  return t.toISOString()
}

// tenant 级裁决：把 orchestrator 的嵌套结果拍平成 job 终态表 + 是否需要接管。
// 终态白名单 + 拓扑校验，一切 unknown/missing 默认 reject（round-3 P1）。
const classifyTenantRun = (r) => {
  const top = (r && typeof r === 'object') ? (r.outcome ?? null) : null
  const jobs = {
    dream: r?.dream?.outcome ?? null,
    reflection: r?.reflection?.outcome ?? null,
    transition: r?.transition?.outcome ?? null,
  }
  const pending = []
  if (!KNOWN_TOPS.has(top)) pending.push(`top:${top ?? 'missing'}`)
  const optionalAfterShortCircuit = top === 'short_circuited_at_dream'
  for (const [job, o] of Object.entries(jobs)) {
    if (o === null) {
      // dream 无条件必须在场；reflection/transition 仅在 short_circuited 形状下合法缺席
      if (job === 'dream' || !optionalAfterShortCircuit) pending.push(`${job}:missing`)
      continue
    }
    if (!TERMINAL.has(o)) pending.push(`${job}:${o}`)
  }
  return { top, jobs, pending }
}

// 依赖注入工厂（Codex round-1 要求的 seam）：单测注入假 runNightly 逐态验证 reject 语义
export const makeHandler = ({ runNightly }) => async (event) => {
  const scheduledFor = canonicalScheduledFor(event)
  const tenants = (process.env.TIDEMARK_NIGHTLY_TENANTS || 'demo-tenant')
    .split(',').map(s => s.trim()).filter(Boolean)
  const results = []
  for (const tenantId of tenants) {
    // 串行执行：pool max=1；单 tenant 非终态/异常不中断其余 tenant，先尽力完成再统一裁决
    try {
      const r = await runNightly({ tenantId, scheduledFor })
      results.push({ tenant_id: tenantId, ...classifyTenantRun(r) })
    } catch (e) {
      console.error(JSON.stringify({ evt: 'nightly_tenant_crashed', tenant_id: tenantId, msg: String(e?.message ?? e).slice(0, 200) }))
      results.push({ tenant_id: tenantId, top: 'crashed', jobs: {}, pending: ['orchestrator:crashed'] })
    }
  }
  const needsTakeover = results.filter(r => r.pending.length > 0)
  const summary = { scheduled_for: scheduledFor, results }
  console.log(JSON.stringify({ evt: 'nightly_handler_done', ...summary, needs_takeover: needsTakeover.length }))
  if (needsTakeover.length > 0) {
    // 让 Lambda 失败 = 异步重试同一 event = 同 run key takeover；嵌套结果已完整落日志
    throw new Error(`nightly needs same-schedule takeover for ${needsTakeover.map(r => `${r.tenant_id}[${r.pending.join(',')}]`).join(' ')}`)
  }
  return summary
}

// 生产入口：secrets 先行（引导顺序契约同 mcp-handler），业务模块动态导入
await bootstrapSecrets()
const { runNightly } = await import('../nightly/orchestrator.mjs')
export const handler = makeHandler({ runNightly })
