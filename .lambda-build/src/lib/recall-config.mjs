// recall 配置默认值（SPEC §11）——独立模块，便于测试 import 而不触发服务端 secret 校验
export const CFG = {
  vector_top_n: 50,               // 目标合格候选数
  overfetch_max: 1600,            // adaptive overfetch 硬上限（有界：50→200→800→1600，最多 4 轮）
  second_path_limit: 20,          // 第二路确定性上限
  semantic_gate: 0.55,
  second_path_floor: 0.35,
  weights: { sim: 0.5, vit: 0.2, util: 0.2, imp: 0.1 },
  event_budget: { max_items: 5, max_tokens: 1200 },
  experience_budget: { max_items: 3, max_tokens: 600 },
  total_token_ceiling: 1800,      // token_budget 默认值 = 两类硬上限之和
  receipt_retention_days: 60,
}
