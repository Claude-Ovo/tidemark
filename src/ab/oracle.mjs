// P0-12 外部 oracle（冻结契约："外部 oracle 判分"）：确定性哨兵匹配，零 LLM 零自评。
// 输入只有 harness 递来的注入集合与期望事实 ID——绝不读 viz、绝不读画面、绝不让被测系统
// 自己给自己打分（injected item 的 content 需要读原文核哨兵：经 detail 面按 agent 键取，
// 或直接由 recall 注入载荷的 content 字段核——两者都是数据面，不经任何呈现层）。
// 评分：score = 命中的 required 事实数 / required 总数（hit@required）。
// 公开 trace 里只出现事实 ID 与哈希，不出现原文（content-free 契约）。

const SENTINEL = /\[FACT:([a-z0-9-]+)\]/g

export const scoreProbe = async ({ injected, required }) => {
  const hitIds = []                 // 命中的 memory_id（供 full 臂做证据链）
  const found = new Set()
  for (const item of injected) {
    // recall 注入载荷本身带 content（agent 面数据）；从中提取哨兵
    const text = item.content ?? ''
    for (const m of text.matchAll(SENTINEL)) {
      if (required.includes(m[1])) { found.add(m[1]); hitIds.push(item.memory_id) }
    }
  }
  return {
    required: required.length,
    hit: found.size,
    hit_ids: [...new Set(hitIds)],
    score: required.length ? +(found.size / required.length).toFixed(4) : 0,
  }
}
