// P0-09 夜间 Lambda 入口：EventBridge 定时规则 -> 本 handler -> per-tenant runNightly。
// scheduled_for 规范化（结论 13：取 EventBridge 规范计划时间）：event.time 向下取整到分钟——
// 同一次计划触发的重试/重复投递携带同一 event.time，规范化后落进同一个 run key
// (tenant, job_kind, scheduled_for, pipeline_version)，nightly_runs 唯一键保证只提交一次；
// 手动测试可传 {"scheduled_for": "<ISO>"} 覆盖。
// 失败语义（结论 13）：意外异常原样抛出 -> Lambda invoke 失败 -> EventBridge retry/DLQ 接手；
// completed_degraded / short_circuited 是诚实的业务终态，返回成功不触发重试
//（内部 retryable 由 lease takeover 在下一次触发时收口，重试风暴解决不了 Bedrock 故障）。
// 同 mcp-handler 的引导顺序契约：业务模块动态导入，保证 secrets 先于任何加载期 env 读取
import { bootstrapSecrets } from '../lib/secrets.mjs'

await bootstrapSecrets()
const { runNightly } = await import('../nightly/orchestrator.mjs')

const canonicalScheduledFor = (event) => {
  const raw = event?.scheduled_for ?? event?.time
  if (!raw) throw new Error('event must carry time (EventBridge) or scheduled_for (manual)')
  const t = new Date(raw)
  if (Number.isNaN(t.getTime())) throw new Error(`unparseable schedule time: ${String(raw).slice(0, 40)}`)
  t.setUTCSeconds(0, 0)
  return t.toISOString()
}

export const handler = async (event) => {
  const scheduledFor = canonicalScheduledFor(event)
  const tenants = (process.env.TIDEMARK_NIGHTLY_TENANTS || 'demo-tenant')
    .split(',').map(s => s.trim()).filter(Boolean)
  const results = []
  for (const tenantId of tenants) {
    // 串行执行：pool max=1，且 per-tenant run 之间无共享状态；单 tenant 失败不吞——
    // 记录后继续其余 tenant，最后有任一异常则整体失败（EventBridge 重试幂等安全）
    try {
      const r = await runNightly({ tenantId, scheduledFor })
      results.push({ tenant_id: tenantId, outcome: r.outcome })
    } catch (e) {
      console.error(JSON.stringify({ evt: 'nightly_tenant_crashed', tenant_id: tenantId, msg: String(e?.message ?? e).slice(0, 200) }))
      results.push({ tenant_id: tenantId, outcome: 'crashed' })
    }
  }
  const crashed = results.filter(r => r.outcome === 'crashed')
  const summary = { scheduled_for: scheduledFor, results }
  console.log(JSON.stringify({ evt: 'nightly_handler_done', ...summary }))
  if (crashed.length > 0) throw new Error(`nightly crashed for ${crashed.length}/${results.length} tenant(s); see logs`)
  return summary
}
