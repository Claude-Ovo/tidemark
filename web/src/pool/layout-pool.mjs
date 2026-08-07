// P0-11 v2「记忆潮池」布局核心（纯函数，node 可测）。
// DESIGN-OCEAN.md v2 编码真相（Codex 九审裁定，2026-08-07 冻结）：
//   粒子 = 一条 memory（不是 episode bubble）
//   s = pinned ? 1 : clamp(effective_strength, 0, 1)
//   r = f(1 - s)：全场唯一固定单调函数（线性映射到 [PIN_RING, 1]）
//   层名只是绝对阈值标尺注记，不是布局输入——禁止任何 percentile / 按样本重排；
//   同 strength 恒同目标半径，邻居变化不得引起径向漂移（P1-1 教训极坐标版）
//   角度无业务语义：时序 rank × golden angle + stable hash tie-break
//   碰撞：先只调角度 → 缩 mark (LOD) → 显式 overflow；
//   v0 骨架不做径向微调——严格保证 r 随 s 单调不反序；密集放不下=诚实 overflow
//   （P1-2 纪律继承：求解失败必须显式，禁止带碰撞冒充成功）
// 输出为单位圆归一化极坐标；渲染层只做等比缩放，不得二次改动 r。

export const POOL_CFG = {
  ANCHOR_MIN: 0.70,      // 校准常量（冻结初值，原型期调后写回 DESIGN-OCEAN.md）
  RECEDING_MAX: 0.35,
  PIN_RING: 0.05,        // pinned 小环轨道半径（不塞几何零点）
  MARK_R: 0.014,         // 基准 mark 半径（归一化单位）
  MARK_R_MIN: 0.007,     // LOD 下限
  SEP: 1.15,             // 中心距下限 = SEP * (rA + rB)
  ANGLE_TRIES: 48,       // 碰撞角向扫描次数（左右交替）
  ANGLE_STEP: 0.045,     // 每次角向步长（rad）
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))   // ≈ 2.399963

// FNV-1a：stable hash tie-break（刷新确定性，不引入 Math.random）
export const stableHash = (str) => {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export const strengthOf = (m) => (m.pinned ? 1 : Math.min(1, Math.max(0, Number(m.effective_strength))))

// r = f(1-s)：单调、全场唯一。非 pinned 线性映射到 [PIN_RING, 1]，pinned 恒在 PIN_RING 环。
export const radiusOf = (m, cfg = POOL_CFG) =>
  m.pinned ? cfg.PIN_RING : cfg.PIN_RING + (1 - cfg.PIN_RING) * (1 - strengthOf(m))

// 绝对阈值标尺 → 层名（注记用，绝不反过来当布局输入）
export const layerOf = (m, cfg = POOL_CFG) => {
  if (m.pinned) return 'anchor'
  const s = strengthOf(m)
  if (s >= cfg.ANCHOR_MIN) return 'anchor'
  if (s > cfg.RECEDING_MAX) return 'active_tide'
  return 'receding_edge'
}

// fade line 半径（外缘警戒线；fade_threshold 只来自服务端快照，禁止第二真相源）
export const fadeLineRadius = (fadeThreshold, cfg = POOL_CFG) =>
  cfg.PIN_RING + (1 - cfg.PIN_RING) * (1 - fadeThreshold)

const collides = (a, b, cfg) => {
  const ax = a.r * Math.cos(a.theta), ay = a.r * Math.sin(a.theta)
  const bx = b.r * Math.cos(b.theta), by = b.r * Math.sin(b.theta)
  return (ax - bx) ** 2 + (ay - by) ** 2 < (cfg.SEP * (a.markR + b.markR)) ** 2
}

// layoutPool(memories, { cfg }) -> { placed, overflow }
// memories: [{ memory_id, pinned, effective_strength, created_at }]（episode 分组不进布局）
// placed:   [{ memory_id, s, layer, r, theta, markR }]——r 恒等于 radiusOf，零径向妥协
// overflow: [{ memory_id, s, layer, reason: 'placement_overflow' }]——显式，绝不静默
export const layoutPool = (memories, { cfg = POOL_CFG } = {}) => {
  // 时序 rank：created_at 升序，tie 用 stable hash（轮询/刷新不重排）
  const ranked = [...memories].sort((a, b) =>
    (new Date(a.created_at) - new Date(b.created_at)) ||
    (stableHash(a.memory_id) - stableHash(b.memory_id)) ||
    (a.memory_id < b.memory_id ? -1 : 1))

  const placed = []
  const overflow = []
  let pinRank = 0
  for (let i = 0; i < ranked.length; i++) {
    const m = ranked[i]
    const s = strengthOf(m)
    const layer = layerOf(m, cfg)
    const r = radiusOf(m, cfg)
    // pinned 用环内独立 rank（小环均匀展开）；非 pinned 用全局时序 rank
    const rank = m.pinned ? pinRank++ : i
    const baseTheta = rank * GOLDEN + (stableHash(m.memory_id) % 997) / 997 * 0.02

    let candidate = null
    outer:
    for (const markR of [cfg.MARK_R, (cfg.MARK_R + cfg.MARK_R_MIN) / 2, cfg.MARK_R_MIN]) {
      for (let t = 0; t <= cfg.ANGLE_TRIES; t++) {
        const dTheta = (t % 2 === 0 ? 1 : -1) * Math.ceil(t / 2) * cfg.ANGLE_STEP
        const cand = { memory_id: m.memory_id, s, layer, r, theta: baseTheta + dTheta, markR }
        if (!placed.some(p => collides(cand, p, cfg))) { candidate = cand; break outer }
      }
    }
    if (candidate) placed.push(candidate)
    else overflow.push({ memory_id: m.memory_id, s, layer, reason: 'placement_overflow' })
  }

  // 落位后 pairwise 断言（P1-2：绝不带碰撞冒充成功）
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (collides(placed[i], placed[j], cfg)) {
        throw new Error(`layout invariant violated: overlap ${placed[i].memory_id} x ${placed[j].memory_id}`)
      }
    }
  }
  return { placed, overflow }
}
