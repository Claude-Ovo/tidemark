// P0-11 v2「记忆潮池」布局核心（纯函数，node 可测）。
// DESIGN-OCEAN.md v2 编码真相（Codex 九审裁定，2026-08-07 冻结；v2 一审 P1-3/P1-4 修订）：
//   粒子 = 一条 memory（不是 episode bubble）
//   s = pinned ? 1 : clamp(effective_strength, 0, 1)
//   r = f(1 - s)：全场唯一固定单调函数，线性映射到 [PIN_RING, 1 - OUTER_INSET]
//   （OUTER_INSET 覆盖最大 mark + 描边 + 焦点 halo：s=0 的粒子完整可见，
//    不靠 Canvas clip 把数据切掉——Codex v2 一审 P1-3）
//   层名只是绝对阈值标尺注记，不是布局输入——禁止任何 percentile / 按样本重排；
//   同 strength 恒同目标半径，邻居变化不得引起径向漂移（P1-1 教训极坐标版）
//   角度无业务语义：时序 rank × golden angle + stable hash tie-break
//   碰撞：先只调角度 → 缩 mark (LOD) → 显式 overflow；
//   邻居查询走空间哈希网格（O(1) 均摊），74/500/2000 三档预算在回归中计时
//   （Codex v2 一审 P1-4：线性扫 placed 在 2000 档 ~8s，不满足可交互）
//   零径向妥协——严格保证 r 随 s 单调不反序；密集放不下=诚实 overflow
//   （P1-2 纪律继承：求解失败必须显式，禁止带碰撞冒充成功）
// 输出为单位圆归一化极坐标；渲染层只做等比缩放，不得二次改动 r。

export const POOL_CFG = {
  ANCHOR_MIN: 0.70,      // 待校准视觉假设（Codex 裁定：版本化冻结前不称常量）
  RECEDING_MAX: 0.35,
  PIN_RING: 0.05,        // pinned 小环轨道半径（不塞几何零点）
  MARK_R: 0.014,         // 基准 mark 半径（归一化单位）
  MARK_R_MIN: 0.007,     // LOD 下限
  HALO_R: 0.010,         // 描边 + 焦点 halo 预留
  OUTER_INSET: 0.024,    // >= MARK_R + HALO_R：径向中心上界 = 1 - OUTER_INSET
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

const rSpan = (cfg) => 1 - cfg.OUTER_INSET - cfg.PIN_RING

// r = f(1-s)：单调、全场唯一。非 pinned 线性映射到 [PIN_RING, 1-OUTER_INSET]，
// pinned 恒在 PIN_RING 环。s=0 时 r+mark+halo <= 1，粒子完整在池内。
export const radiusOf = (m, cfg = POOL_CFG) =>
  m.pinned ? cfg.PIN_RING : cfg.PIN_RING + rSpan(cfg) * (1 - strengthOf(m))

// 绝对阈值标尺 → 层名（注记用，绝不反过来当布局输入）
export const layerOf = (m, cfg = POOL_CFG) => {
  if (m.pinned) return 'anchor'
  const s = strengthOf(m)
  if (s >= cfg.ANCHOR_MIN) return 'anchor'
  if (s > cfg.RECEDING_MAX) return 'active_tide'
  return 'receding_edge'
}

// fade line 半径（外缘警戒线；与 radiusOf 同一映射——同一真相源，
// fade_threshold 只来自服务端快照）
export const fadeLineRadius = (fadeThreshold, cfg = POOL_CFG) =>
  cfg.PIN_RING + rSpan(cfg) * (1 - fadeThreshold)

// ---- 空间哈希网格：cell 边长必须 >= 最大碰撞判定距离 SEP*(2*MARK_R)，3x3 邻域即全覆盖
const cellSizeOf = (cfg) => Math.max(cfg.SEP * 2 * cfg.MARK_R, 1e-6)
const makeGrid = (cfg) => ({ cell: cellSizeOf(cfg), map: new Map() })
const cellKey = (cx, cy) => `${cx}|${cy}`
const gridInsert = (g, p) => {
  const x = p.r * Math.cos(p.theta), y = p.r * Math.sin(p.theta)
  const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell)
  const k = cellKey(cx, cy)
  if (!g.map.has(k)) g.map.set(k, [])
  g.map.get(k).push({ ...p, x, y })
}
const gridCollides = (g, cand, cfg) => {
  const x = cand.r * Math.cos(cand.theta), y = cand.r * Math.sin(cand.theta)
  const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const bucket = g.map.get(cellKey(cx + dx, cy + dy))
    if (!bucket) continue
    for (const p of bucket) {
      const lim = cfg.SEP * (cand.markR + p.markR)
      if ((x - p.x) ** 2 + (y - p.y) ** 2 < lim * lim) return true
    }
  }
  return false
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
  const grid = makeGrid(cfg)
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
        if (!gridCollides(grid, cand, cfg)) { candidate = cand; break outer }
      }
    }
    if (candidate) {
      placed.push(candidate)
      gridInsert(grid, candidate)
    } else {
      overflow.push({ memory_id: m.memory_id, s, layer, reason: 'placement_overflow' })
    }
  }

  // 落位后不变量断言（P1-2：绝不带碰撞冒充成功；P1-3：可见半径全在池内）
  const check = makeGrid(cfg)
  for (const p of placed) {
    if (p.r + p.markR + cfg.HALO_R > 1) {
      throw new Error(`layout invariant violated: ${p.memory_id} visible radius exceeds pool (r=${p.r})`)
    }
    if (gridCollides(check, p, cfg)) {
      throw new Error(`layout invariant violated: overlap at ${p.memory_id}`)
    }
    gridInsert(check, p)
  }
  return { placed, overflow }
}
