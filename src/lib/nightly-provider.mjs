// nightly 模型段 provider 层（P0-07，方案 B/C）：DREAM_PROVIDER=bedrock|stub——
// 同 P0-01 的 EMBED_PROVIDER 模式（结论 36）：Bedrock allowlisting 批复前 stub 先行，
// stub 是【确定性】产物且显式标注 provider，绝不冒充 LLM；批后真件补验。
// 模型只产叙述字段（summary/salient_points/trigger/wrong_action/correct_action/caution）；
// evidence_ids/time_range/scope 校验由 server 封口（方案二审#6），不在此层。
export const NIGHTLY_PROVIDER = process.env.DREAM_PROVIDER === 'bedrock' ? 'bedrock' : 'stub'
export const NIGHTLY_MODEL_ID = NIGHTLY_PROVIDER === 'bedrock'
  ? (process.env.DREAM_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0')
  : 'stub-deterministic-v1'
export const PROMPT_VERSION = 'nightly-prompt-v1'

const clip = (s, n) => (s ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, n)

// dream：整簇正文 -> { summary, salient_points[] }。确定性：同输入同输出。
export const dreamSummarize = async (cluster) => {
  if (NIGHTLY_PROVIDER === 'bedrock') throw new Error('bedrock_provider_not_wired_yet')   // allowlisting 批后接（结论 36）
  const bodies = cluster.map(m => clip(m.content, 120))
  return {
    summary: clip(`Condensed ${cluster.length} low-salience fragments: ` + bodies.join(' | '), 800),
    salient_points: bodies.slice(0, 5),
  }
}

// reflection：配对上下文 -> 叙述字段。确定性 stub 从 anchor 事件构造。
export const reflectExtract = async (pairContext) => {
  if (NIGHTLY_PROVIDER === 'bedrock') throw new Error('bedrock_provider_not_wired_yet')
  const err = pairContext.failure_events.find(e => e.event_type === 'tool_error')
  const corr = pairContext.failure_events.find(e => e.event_type === 'user_correction')
  return {
    // 叙述讲模式不讲个例：不嵌 attempt id——经验的语义单位是 task 级教训，
    // 同 task 的重复教训应当在语义上可合并（dedup 才有意义）
    trigger: clip(`when ${err?.payload?.error_type ?? 'a failure'} occurs in ${pairContext.task_instance_id}`, 200),
    wrong_action: clip(`the failing approach first recorded for ${pairContext.task_instance_id}`, 200),
    correct_action: clip(`the approach of the earliest subsequent success` + (corr ? ' (after user correction)' : ''), 200),
    caution: clip(`verify against ${err?.payload?.error_type ?? 'the failure mode'} before retrying`, 200),
    confidence: 0.5,
  }
}
