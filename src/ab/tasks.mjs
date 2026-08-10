// P0-12 三臂 A/B 任务 fixture（预审修订版）。
// 口径（Codex 预审裁定）：`model: null, agent_policy: deterministic-v1`；指标为
// injection hit / lifecycle ablation，不冒充生成质量或端到端 agent success。
// 哨兵撤出正文（预审方法学建议）：事实原文不含任何标记——oracle 判分走
// plant 期建立的 memory_id→fact_id 外部 fixture map，标签不改变检索输入。
//
// 场景语法（steps）：
//   { op: 'plant', facts: [{ id, text, importance?, poison?, foreign? }], agent? }
//     - poison=过期/错误事实；agent='ab-other' 时由同 tenant 另一 agent 植入（隔离场景）；
//       foreign 事实出现在本 agent 的 used 里即隔离失守（记 0 分）
//   { op: 'distract', count }
//   { op: 'probe', query, required: [...], given?: [...], forbidden?: [...],
//     expect_abstain?: true, outcome?: true | 'cancelled' }
//     - required：需要靠记忆命中的事实 id
//     - given：任务文本自带的事实 id（negative control①：三臂都该得分，no-memory 不被锁死为 0）
//     - forbidden：出现在 used 即 0 分（cancelled-null 场景：被取消的结果不得抬升排名）
//     - poison 命中（negative control②）：使用了 poison 事实 → 该 probe 记 0 分
//     - expect_abstain（negative control③）：无可靠记忆时正确行为是弃权——policy 弃权=满分
//     - outcome: true 时 full 臂按 oracle 结果派生 report_outcome（success 派 credited 命中项；
//       miss 报 failure 零 attribution——不伪造因果）；outcome: 'cancelled' 时 full 臂
//       上报 status='cancelled' 零 attribution（零塑性契约的评测面）

export const SUITE_VERSION = 'ab-suite-v4'

// v4 分组（预审裁定：headline 不出单一均分）——
// main effectiveness / negative control / diagnostic，run-ab 分组出报表
export const GROUPS = { MAIN: 'main', CONTROL: 'control', DIAGNOSTIC: 'diagnostic' }

// paraphrase 冻结判据（Codex v4 ack 解释②：不引 jieba，代码内可机械复算，判据版本进 corpus digest）：
// NFKC + lowercase + 去标点/空白后，两串不共享任何长度≥2 的连续 CJK 子串
export const PARAPHRASE_CRITERION = 'no-shared-cjk-bigram-v1'
const cjkNorm = (s) => s.normalize('NFKC').toLowerCase().replace(/[^\p{Script=Han}]/gu, '')
export const paraphraseDisjoint = (a, b) => {
  const na = cjkNorm(a), nb = cjkNorm(b)
  const grams = new Set()
  for (let i = 0; i + 1 < na.length; i++) grams.add(na.slice(i, i + 2))
  for (let i = 0; i + 1 < nb.length; i++) if (grams.has(nb.slice(i, i + 2))) return false
  return true
}

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
// foreign: 由另一 agent（ab-other）植入——出现在本 agent 的 used【或完整 receipt 候选】里
// 即隔离失守，记 0 分（v4 预审加严）
const FX = (id, text, importance = 0.6) => ({ id, text, importance, foreign: true })

// v4 配对模板（预审裁定：matched control 不靠注释假定，靠同一生成函数 + receipt 前置断言）——
// credited 与 cancelled 场景同构：同候选数 6、同 probe 结构（2 定向 + 1 泛指坑位竞争）、
// 同 distract 节奏、同 importance 分布；仅词汇槽与 treatment 不同。
// 泛指 probe 标 precondition:'contention'——run-ab 按 receipt 验前置（vector 臂目标必须
// 在注入席外），不成立标 invalid_fixture 不计入分组统计。
const NUM_ZH = ['', '一', '二', '三', '四', '五']
const plasticityPairScenario = ({ id, title, group, treatment, slot }) => ({
  id, title, group,
  steps: [
    { op: 'plant', facts: [
      F(`${slot.key}-target`, `${slot.domain}：${slot.targetTail}`),
      ...[1, 2, 3, 4, 5].map(i => F(`${slot.key}-c${i}`, `${slot.domain}：${slot.fillerTail}${NUM_ZH[i]}`)),
    ] },
    { op: 'distract', count: 4 },
    { op: 'probe', query: slot.q1, required: [`${slot.key}-target`], outcome: treatment },
    { op: 'probe', query: slot.q2, required: [`${slot.key}-target`], outcome: treatment },
    { op: 'distract', count: 4 },
    ...(treatment === true
      ? [{ op: 'probe', query: slot.generic, required: [`${slot.key}-target`], outcome: true, precondition: 'contention' }]
      : [{ op: 'probe', query: slot.generic, required: [], given: ['ctx'], forbidden: [`${slot.key}-target`],
          precondition: 'contention', control_probe: true }]),   // control 的 pass-fail 只看断言 probe（设置 probes 不算）
  ],
})

export const SCENARIOS = [
  {
    id: 'sc-retention', group: GROUPS.MAIN,
    title: '基础保持：植入后经受干扰仍能召回',
    steps: [
      { op: 'plant', facts: [F('ship-addr', '客户 Lin 的收货地址已经改到滨江路 88 号仓库'), F('ship-window', '客户 Lin 只接受工作日上午十点前收货')] },
      { op: 'distract', count: 8 },
      { op: 'probe', query: '客户 Lin 的收货地址改到了哪里，收货时间有什么要求', required: ['ship-addr', 'ship-window'], outcome: true },
    ],
  },
  {
    id: 'sc-interference', group: GROUPS.MAIN,
    title: '干扰区分：同主题相近事实不串',
    steps: [
      { op: 'plant', facts: [F('price-a', '产品 A 型号的报价底线是每台 1200 元'), F('price-b', '产品 B 型号的报价底线是每台 900 元')] },
      { op: 'distract', count: 10 },
      { op: 'probe', query: '产品 B 型号的报价底线是每台多少元', required: ['price-b'], outcome: true },
    ],
  },
  {
    id: 'sc-outcome-gate', group: GROUPS.MAIN,
    title: '结果门控：outcome-gated 复合塑性（utility 计数+anchor 双通道）后，同主题直查仍保持命中',
    steps: [
      { op: 'plant', facts: [F('policy-new', '退款流程从 2026 年 7 月起改为线上工单直接审批', 0.5)] },
      { op: 'distract', count: 6 },
      { op: 'probe', query: '退款流程从什么时候起改成线上工单直接审批', required: ['policy-new'], outcome: true },
      { op: 'distract', count: 6 },
      { op: 'probe', query: '退款流程现在是不是线上工单直接审批', required: ['policy-new'], outcome: true },
    ],
  },
  {
    id: 'nc-given', group: GROUPS.CONTROL,
    title: '对照①：任务自带答案——三臂（含 no-memory）都应得分',
    steps: [
      { op: 'distract', count: 4 },
      { op: 'probe', query: '按任务单说明处理（任务单已注明：包裹送 3 号门收发室）', required: [], given: ['dock-3'] },
    ],
  },
  {
    id: 'nc-stale', group: GROUPS.CONTROL,
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
      // 终验（control 断言 probe）：full 臂毒记忆经两轮 blamed 排出注入席（pass=自愈）；
      // vector 臂零塑性继续中毒（FAIL=设计的易感性证据，不是 control 失效）
      { op: 'probe', query: '再确认一次提货安排（任务单注明地址：高新区创业大道 5 号），仓库提货的地址和注意事项', required: [], given: ['addr-new'], outcome: true, control_probe: true },
    ],
  },
  {
    id: 'nc-abstain', group: GROUPS.CONTROL,
    title: '对照③：无可靠记忆应弃权——零注入=正确',
    steps: [
      { op: 'distract', count: 6 },
      { op: 'probe', query: '客户 Zhao 的合同截止日期是哪一天', required: [], expect_abstain: true },
    ],
  },
  // v4：配对场景由同一模板生成（matched control，预审裁定）——
  // sc-credited-plasticity 展示【复合塑性效应】（credited 同时抬 utility 计数与 strength
  // anchor，不宣称单因素）的坑位竞争占优；sc-cancelled-null 是它的配对反面（cancelled 零塑性）。
  // 目标措辞受 exp 377a717d3c8e receipt 校准：塑性可填平 ~0.06 的 final_score 沟，填不动 0.15。
  plasticityPairScenario({
    id: 'sc-credited-plasticity', group: GROUPS.MAIN, treatment: true,
    title: '复合塑性 rerank 占优：两轮 credited（utility 计数+anchor 双通道）后坑位竞争把目标挤回注入席',
    slot: {
      key: 'ut', domain: '供应商合作备忘',
      targetTail: '结算打款的周期，财务确认是每月十五号统一处理',
      fillerTail: '对接流程和注意事项汇总',
      q1: '供应商结算打款是每月几号',
      q2: '财务确认的供应商统一打款日是十五号吗',
      generic: '供应商合作备忘对接流程注意事项',
    },
  }),
  plasticityPairScenario({
    id: 'sc-cancelled-null', group: GROUPS.CONTROL, treatment: 'cancelled',
    title: 'cancelled 零塑性（credited 场景的 matched negative control）：取消的结果不得产生任何 rerank 提升',
    slot: {
      key: 'cn', domain: '仓储管理备忘',
      targetTail: '保险续保的窗口，行政确认是每年三月第一周统一办理',
      fillerTail: '日常巡检和台账要点汇总',
      q1: '仓储保险续保是每年几月',
      q2: '行政确认的仓储统一续保周是三月第一周吗',
      generic: '仓储管理备忘日常巡检台账要点',
    },
  }),
  {
    id: 'sc-paraphrase', group: GROUPS.DIAGNOSTIC,
    title: `纯语义改写（diagnostic，冻结判据 ${PARAPHRASE_CRITERION}：NFKC+lowercase+去非汉字后，probe 与目标事实不共享任何长度≥2 的连续 CJK 子串——代码内可机械复算，见 paraphraseDisjoint）——诚实测 onnx 中文语义检索，失败不进功能回归 gate`,
    steps: [
      { op: 'plant', facts: [F('para-fact', '新来的实习生小周负责整理每周的客户回访记录')] },
      { op: 'distract', count: 6 },
      { op: 'probe', query: '刚入职那位年轻同事的任务是汇总顾客反馈档案', required: ['para-fact'], outcome: true },
    ],
  },
  {
    id: 'sc-importance', group: GROUPS.MAIN,
    title: 'high-importance 第二路 admission + rerank 权重（复合路径）：同主题坑位竞争中高重要度事实占席',
    steps: [
      { op: 'plant', facts: [
        F('imp-target', '设备年检备忘：主变压器的年检必须在停电窗口内完成', 0.95),
        F('imp-c1', '设备年检备忘：常规巡检记录归档说明一', 0.35),
        F('imp-c2', '设备年检备忘：常规巡检记录归档说明二', 0.35),
        F('imp-c3', '设备年检备忘：常规巡检记录归档说明三', 0.35),
        F('imp-c4', '设备年检备忘：常规巡检记录归档说明四', 0.35),
        F('imp-c5', '设备年检备忘：常规巡检记录归档说明五', 0.35),
      ] },
      { op: 'distract', count: 4 },
      { op: 'probe', query: '设备年检备忘常规巡检归档', required: ['imp-target'], outcome: true },
    ],
  },
  {
    id: 'sc-slot-pressure', group: GROUPS.DIAGNOSTIC,
    title: '注入预算压力：7 条相关记忆抢 5 席——上限的诚实度（partial score 为正确答案）',
    steps: [
      { op: 'plant', facts: [
        F('sp-1', '展会筹备清单：主舞台背板尺寸三米乘六米'),
        F('sp-2', '展会筹备清单：宣传物料周四前送印刷厂'),
        F('sp-3', '展会筹备清单：嘉宾胸牌按姓氏拼音排序'),
        F('sp-4', '展会筹备清单：茶歇供应商需要提前两天确认人数'),
        F('sp-5', '展会筹备清单：现场网络要单独拉一条专线'),
        F('sp-6', '展会筹备清单：消防通道展位图必须报场馆审批'),
        F('sp-7', '展会筹备清单：撤展时间是活动结束后四小时内'),
      ] },
      { op: 'distract', count: 4 },
      // required 全 7——预算 5 席封顶：raw coverage=5/7，budget_cap 使 oracle 另报
      // budget-normalized success（found === min(required, cap) ⇒ 1）；ceiling 少于 5 时如实失败
      { op: 'probe', query: '展会筹备清单都有哪些事项', required: ['sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-5', 'sp-6', 'sp-7'], budget_cap: 5 },
    ],
  },
  {
    id: 'sc-agent-isolation', group: GROUPS.CONTROL,
    title: 'agent 隔离：同 tenant 另一 agent 植入语义最相关的事实——本 agent 召回零泄露',
    steps: [
      // ab-other 植入与 probe 几乎同文的事实（语义上最强候选）；本 agent 只有远弱于它的自有事实
      { op: 'plant', agent: 'ab-other', facts: [FX('iso-foreign', '季度预算评审会定在下周三上午十点的大会议室')] },
      { op: 'plant', facts: [F('iso-own', '季度预算相关：报销单据要在评审会前交齐')] },
      { op: 'distract', count: 4 },
      // 唯一成败条件是隔离：foreign 出现在 used 即 0 分；干净即得分（given 占位），
      // 自有事实只是真实感 decoy，不作为命中要求（its 词面与 query 距离远，不设 flaky 断言）
      { op: 'probe', query: '季度预算评审会是什么时候在哪开', required: [], given: ['iso-ctx'] },
    ],
  },
]

// 一审 P1-3：干扰语料与生成规则属于 canonical suite definition 的一部分——
// 由 harness 的 corpus_digest 全量 hash（改任何一条干扰文本 = 新 exp_id 新 tenant）。
export const DISTRACT_GENERATOR_VERSION = 'mulberry32-pool-pick-v1'
export const DISTRACT_POOL = [
  '例行周报已提交，无异常', '会议室预定系统下午维护', '打印机墨盒已更换',
  '团建时间待定', '门禁卡续期提醒', '停车场月租下月调价', '咖啡机除垢完成',
  '快递代收点搬到二楼', '空调温度统一调至 26 度', '年度体检安排在十月',
  '工位绿植浇水轮值更新', '内网密码九十天到期提醒',
]
// pool 显式传入（二审 P1-1 单一入口：执行用的语料必须就是 identity hash 过的那份 frozen suite）
export const distractText = (rng, i, pool = DISTRACT_POOL) =>
  `${pool[Math.floor(rng() * pool.length)]}（批次 ${i}-${Math.floor(rng() * 1e6)}）`
