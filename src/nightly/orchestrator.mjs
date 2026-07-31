// per-tenant nightly orchestrator（P0-07 方案二审#7 + 收口#5，单入口二选一的"单 orchestrator"方案）：
// 顺序 dream -> reflection -> transition。
// 短路规则：dream running/retryable（lease held / transient 待 takeover）-> 停，本次调用不
// 继续后续 job（transition 不得抢 fade dream 正在处理的源）；dream terminal failed ->
// transition 照跑（degraded：防 Bedrock 持续故障饿死确定性 fade/consolidate，二审收口#5——
// transition 只按自身规则处理原 sources，dream 保持零产物零专属 fade）。
// EventBridge（P0-09）只触发本入口；重复 invocation 撞 running dream 即整体退出。
// 用法：node --env-file=.env src/nightly/orchestrator.mjs --scheduled-for <ISO> [--tenant demo-tenant]
import { pathToFileURL } from 'node:url'
import { runDream } from './dream.mjs'
import { runReflection } from './reflection.mjs'
import { runTransition } from './transition.mjs'

// dream 占用 memory sources：running/暂态/stale（revision 变动，可能马上 reacquire）都必须
// 短路 transition，否则 transition 会抢 fade dream 正在处理的源（代码一审#2 前半）。
const DREAM_SHORT_CIRCUIT = new Set(['lease_held', 'retryable', 'stale', 'refused_future_evaluation'])

export const runNightly = async ({ tenantId, scheduledFor, _jobs = {} }) => {
  const jobs = { runDream, runReflection, runTransition, ..._jobs }   // 注入 seam：仅异常契约测试用
  const dream = await jobs.runDream({ tenantId, scheduledFor })
  if (DREAM_SHORT_CIRCUIT.has(dream.outcome)) {
    const r = { outcome: 'short_circuited_at_dream', dream }
    console.log(JSON.stringify({ evt: 'nightly_orchestrator', tenant_id: tenantId, scheduled_for: scheduledFor, ...r }))
    return r
  }
  const degraded = dream.outcome === 'failed' || dream.outcome === 'failed_terminal'
  // reflection 不占 memory sources（消费的是 outcomes/attempt_events）：无论模型终态/暂态
  // 都不得阻止 deterministic transition——Bedrock reflection 故障绝不饿死 lifecycle
  //（代码一审#2 后半）。future evaluation 由 transition 自身的硬闸同样 fail-closed。
  // round-3 #3：reflection 的【异常】同样不得阻断 transition——try/catch 结构化，
  // transition 无条件尝试（reflection 自身已保证不悬 running）
  let reflection
  try {
    reflection = await jobs.runReflection({ tenantId, scheduledFor })
  } catch (e) {
    reflection = { outcome: 'crashed', error: String(e?.message ?? e).slice(0, 160) }
    console.error(JSON.stringify({ evt: 'reflection_crashed', tenant_id: tenantId, error: reflection.error }))
  }
  const transition = await jobs.runTransition({ tenantId, scheduledFor })
  // reflection 的 crashed/failed/retryable 同样降级顶层 outcome（round-5 #5）——
  // 监控不得把丢失的 reflection 当整晚完全成功
  const reflectionDegraded = ['crashed', 'failed', 'failed_terminal', 'retryable'].includes(reflection.outcome)
  const r = { outcome: (degraded || reflectionDegraded) ? 'completed_degraded' : 'completed', dream, reflection, transition }
  console.log(JSON.stringify({ evt: 'nightly_orchestrator', tenant_id: tenantId, scheduled_for: scheduledFor,
    outcome: r.outcome, dream: dream.outcome, reflection: reflection.outcome, transition: transition.outcome }))
  return r
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let scheduledFor = null, tenantId = 'demo-tenant'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scheduled-for') scheduledFor = args[++i]
    else if (args[i] === '--tenant') tenantId = args[++i]
    else throw new Error(`unknown argument: ${args[i]}`)
  }
  if (!scheduledFor) throw new Error('--scheduled-for <ISO timestamp> is required (EventBridge canonical time)')
  const { getPool } = await import('../lib/db.mjs')
  try { await runNightly({ tenantId, scheduledFor }) } finally { await getPool().end().catch(() => {}) }
}
