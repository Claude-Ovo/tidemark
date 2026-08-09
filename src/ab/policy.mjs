// P0-12 确定性脚本 policy（一审 P1-2：与 oracle/evidence 真正分层）。
// 这一层看不见任何 ground truth——没有 required、没有 poisonIds、没有 factOf。
// 输入只有一个真实 agent 在 probe 现场拿得到的东西：任务自带事实(given) + 记忆系统注入了什么(injected)。
// 输出是"行动声明"：用了哪些记忆(used_memory_ids)、是否弃权(abstained)。
// harness 先把行动固化进 trace，oracle 才用 fixture 标签对行动判分，
// evidence 只允许为 policy 事先声明的 used IDs 书写——因果单向，不倒灌。
//
// deterministic-v1 语义（固定脆弱策略，Codex 一审"受控实验"口径）：
//   注入什么用什么，零甄别——记忆质量的差异因此全额传导到任务结果；
//   既无任务自带事实也无注入时弃权。

export const POLICY_VERSION = 'deterministic-v1'

export const deterministicPolicy = ({ given = [], injected = [] }) => {
  const used_memory_ids = injected.map(i => i.memory_id)
  const abstained = used_memory_ids.length === 0 && given.length === 0
  return { policy: POLICY_VERSION, used_memory_ids, abstained }
}
