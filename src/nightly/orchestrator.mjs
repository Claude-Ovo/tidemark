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

const SHORT_CIRCUIT = new Set(['lease_held', 'retryable', 'refused_future_evaluation'])

export const runNightly = async ({ tenantId, scheduledFor }) => {
  const dream = await runDream({ tenantId, scheduledFor })
  if (SHORT_CIRCUIT.has(dream.outcome)) {
    const r = { outcome: 'short_circuited_at_dream', dream }
    console.log(JSON.stringify({ evt: 'nightly_orchestrator', tenant_id: tenantId, scheduled_for: scheduledFor, ...r }))
    return r
  }
  const degraded = dream.outcome === 'failed' || dream.outcome === 'failed_terminal'
  const reflection = await runReflection({ tenantId, scheduledFor })
  if (SHORT_CIRCUIT.has(reflection.outcome)) {
    const r = { outcome: 'short_circuited_at_reflection', dream, reflection }
    console.log(JSON.stringify({ evt: 'nightly_orchestrator', tenant_id: tenantId, scheduled_for: scheduledFor, ...r }))
    return r
  }
  const transition = await runTransition({ tenantId, scheduledFor })
  const r = { outcome: degraded ? 'completed_degraded' : 'completed', dream, reflection, transition }
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
