// P0-12 三臂 A/B 任务 fixture（冻结契约：相同任务/seed/工具/预算，外部 oracle 判分）。
// Bedrock 被拒 → agent 为【确定性脚本执行器】：不做任何自由生成，唯一自由度是
// 记忆系统在 probe 时注入了什么。oracle 判分只看注入集合与期望事实的确定性匹配——
// 零 LLM 噪声，同 seed 逐字节复现，"相同模型"条款以"相同确定性策略"满足（对 Codex 声明）。
//
// 场景语法（steps）：
//   { op: 'plant', facts: [{ id, text, importance? }] }        植入事实（remember）
//   { op: 'distract', count }                                   植入干扰记忆（seeded 生成）
//   { op: 'probe', query, required: [factId...], outcome? }     召回并判分；outcome:'success'|'failure'
//                                                               时 full 臂对首个命中/未命中做 credited/blamed
//   { op: 'wait_decay', hours }                                 记录逻辑时间推进（v1 仅入 trace，不伪造时钟）
//
// 事实 text 内嵌 [FACT:{id}] 哨兵——oracle 用哨兵做确定性匹配，不做语义判断。

export const seededRng = (seed) => {          // mulberry32：任务顺序与干扰语料的唯一随机源
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const F = (id, text, importance = 0.6) => ({ id, text: `${text} [FACT:${id}]`, importance })

// 最小可走通语料（骨架版 3 场景；正式版扩到 ~12 个，含 failure→experience 场景）
export const SCENARIOS = [
  {
    id: 'sc-retention',
    title: '基础保持：植入后经受干扰仍能召回',
    steps: [
      { op: 'plant', facts: [F('ship-addr', '客户 Lin 的收货地址改到了滨江路 88 号仓库'), F('ship-window', '客户 Lin 只接受工作日上午收货')] },
      { op: 'distract', count: 8 },
      { op: 'probe', query: '客户 Lin 收货地址与收货时间', required: ['ship-addr', 'ship-window'], outcome: 'success' },
    ],
  },
  {
    id: 'sc-interference',
    title: '干扰区分：同主题相近事实不串',
    steps: [
      { op: 'plant', facts: [F('price-a', '产品 A 的报价底线是 1200 元'), F('price-b', '产品 B 的报价底线是 900 元')] },
      { op: 'distract', count: 10 },
      { op: 'probe', query: '产品 B 报价底线', required: ['price-b'], outcome: 'success' },
    ],
  },
  {
    id: 'sc-outcome-gate',
    title: '结果门控：credited 的记忆在后续同主题任务中占优',
    steps: [
      { op: 'plant', facts: [F('policy-old', '退款流程按 2025 版手册执行', 0.5), F('policy-new', '退款流程 2026-07 起改为线上工单直批', 0.5)] },
      { op: 'distract', count: 6 },
      { op: 'probe', query: '退款流程当前版本', required: ['policy-new'], outcome: 'success' },   // full 臂 credited policy-new
      { op: 'distract', count: 6 },
      { op: 'probe', query: '退款应该走什么流程', required: ['policy-new'] },                      // 二次：full 臂应因塑性占优
    ],
  },
]

const DISTRACT_POOL = [
  '例行周报已提交，无异常', '会议室预定系统下午维护', '打印机墨盒已更换',
  '团建时间待定', '门禁卡续期提醒', '停车场月租下月调价', '咖啡机除垢完成',
  '快递代收点搬到二楼', '空调温度统一调至 26 度', '年度体检安排在十月',
  '工位绿植浇水轮值更新', '内网密码九十天到期提醒',
]
export const distractText = (rng, i) =>
  `${DISTRACT_POOL[Math.floor(rng() * DISTRACT_POOL.length)]}（批次 ${i}-${Math.floor(rng() * 1e6)}）`
