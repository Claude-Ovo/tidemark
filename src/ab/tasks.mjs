// P0-12 三臂 A/B 任务 fixture（预审修订版）。
// 口径（Codex 预审裁定）：`model: null, agent_policy: deterministic-v1`；指标为
// injection hit / lifecycle ablation，不冒充生成质量或端到端 agent success。
// 哨兵撤出正文（预审方法学建议）：事实原文不含任何标记——oracle 判分走
// plant 期建立的 memory_id→fact_id 外部 fixture map，标签不改变检索输入。
//
// 场景语法（steps）：
//   { op: 'plant', facts: [{ id, text, importance?, poison? }] }   植入（poison=过期/错误事实）
//   { op: 'distract', count }
//   { op: 'probe', query, required: [...], given?: [...], expect_abstain?: true, outcome?: true }
//     - required：需要靠记忆命中的事实 id
//     - given：任务文本自带的事实 id（negative control①：三臂都该得分，no-memory 不被锁死为 0）
//     - poison 命中（negative control②）：注入了 poison 事实 → 该 probe 记 0 分
//     - expect_abstain（negative control③）：无可靠记忆时正确行为是弃权——零注入=满分，注入即 0
//     - outcome: true 时 full 臂按 oracle 结果派生 report_outcome（success 派 credited 命中项；
//       miss 报 failure 零 attribution——不伪造因果，预审 P1-1）

export const SUITE_VERSION = 'ab-suite-v2'

export const seededRng = (seed) => {          // mulberry32
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const F = (id, text, importance = 0.6, poison = false) => ({ id, text, importance, poison })

export const SCENARIOS = [
  {
    id: 'sc-retention',
    title: '基础保持：植入后经受干扰仍能召回',
    steps: [
      { op: 'plant', facts: [F('ship-addr', '客户 Lin 的收货地址已经改到滨江路 88 号仓库'), F('ship-window', '客户 Lin 只接受工作日上午十点前收货')] },
      { op: 'distract', count: 8 },
      { op: 'probe', query: '客户 Lin 的收货地址改到了哪里，收货时间有什么要求', required: ['ship-addr', 'ship-window'], outcome: true },
    ],
  },
  {
    id: 'sc-interference',
    title: '干扰区分：同主题相近事实不串',
    steps: [
      { op: 'plant', facts: [F('price-a', '产品 A 型号的报价底线是每台 1200 元'), F('price-b', '产品 B 型号的报价底线是每台 900 元')] },
      { op: 'distract', count: 10 },
      { op: 'probe', query: '产品 B 型号的报价底线是每台多少元', required: ['price-b'], outcome: true },
    ],
  },
  {
    id: 'sc-outcome-gate',
    title: '结果门控：credited 记忆经 utility 计数在后续同主题占优',
    steps: [
      { op: 'plant', facts: [F('policy-new', '退款流程从 2026 年 7 月起改为线上工单直接审批', 0.5)] },
      { op: 'distract', count: 6 },
      { op: 'probe', query: '退款流程从什么时候起改成线上工单直接审批', required: ['policy-new'], outcome: true },
      { op: 'distract', count: 6 },
      { op: 'probe', query: '退款流程现在是不是线上工单直接审批', required: ['policy-new'], outcome: true },
    ],
  },
  {
    id: 'nc-given',
    title: '对照①：任务自带答案——三臂（含 no-memory）都应得分',
    steps: [
      { op: 'distract', count: 4 },
      { op: 'probe', query: '按任务单说明处理（任务单已注明：包裹送 3 号门收发室）', required: [], given: ['dock-3'] },
    ],
  },
  {
    id: 'nc-stale',
    title: '对照②+生命周期分化：过期记忆被 blamed 后 full 臂应压掉它，vector 臂持续中毒',
    steps: [
      { op: 'plant', facts: [F('addr-old', '仓库提货地址在旧城区光明路 12 号', 0.7, true)] },   // poison：已过期
      { op: 'distract', count: 4 },
      // 任务自带当前真值（given）；注入过期地址 → 0 分；full 臂对被使用的毒记忆打 blamed
      //（poison 命中 = deterministic policy "明确使用了错误记忆"的可审计场景，预审留门）
      { op: 'probe', query: '按任务单地址提货（任务单已注明新地址：高新区创业大道 5 号），仓库提货地址在哪里', required: [], given: ['addr-new'], outcome: true },
      // 坑位竞争（分化的物理前提）：降权只动排名，排名只在注入预算（5 席）被抢满时起杀伤——
      // 种五条同主题合法记忆，使 p2 有六个相关候选抢五席：full 臂被 blamed 降权的毒记忆
      // 排出前五出局；vector 臂零塑性，毒记忆照常占席
      { op: 'plant', facts: [
        F('wh-hours', '仓库提货注意事项：提货窗口是每天上午九点到十一点半'),
        F('wh-gate', '仓库提货注意事项：车辆走东侧二号闸口登记进入'),
        F('wh-contact', '仓库提货注意事项：对接人刘师傅，到场先打电话联系'),
        F('wh-slip', '仓库提货注意事项：需要携带盖章的提货单原件'),
        F('wh-park', '仓库提货注意事项：装卸区限停三十分钟，超时会被拖走'),
        F('wh-plan', '仓库提货安排注意事项：提货安排如有变动会提前一天在群里通知'),
      ] },
      // 第二击：坏记忆不会一次死——再中毒再 blamed（utility 0.33→0.25，vitality 连降）
      { op: 'probe', query: '提货前核对（任务单地址：高新区创业大道 5 号），仓库提货地址再报一遍', required: [], given: ['addr-new'], outcome: true },
      { op: 'distract', count: 4 },
      // 终验：full 臂毒记忆经两轮 blamed 排出注入席（得分）；vector 臂零塑性继续中毒（0 分）
      { op: 'probe', query: '再确认一次提货安排（任务单注明地址：高新区创业大道 5 号），仓库提货的地址和注意事项', required: [], given: ['addr-new'], outcome: true },
    ],
  },
  {
    id: 'nc-abstain',
    title: '对照③：无可靠记忆应弃权——零注入=正确',
    steps: [
      { op: 'distract', count: 6 },
      { op: 'probe', query: '客户 Zhao 的合同截止日期是哪一天', required: [], expect_abstain: true },
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
