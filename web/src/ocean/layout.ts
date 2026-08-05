// 布局映射 v3（七审施工单 C：深度生态）。
// 数据真相只认服务端 effective_strength / pinned / fade_threshold；前端不造权重。
// - episodeStrength = 0.65*max + 0.35*mean（简单均值会把一颗重要记忆抹平）；含 pinned 成员直入浅海带
// - 水体四带：浅海/中层/深水/珊瑚带，带内按 strength 连续插值，弱者绝不画在强者上方
// - percentile spread（≤30%）：只拉开画面不改次序，receipt/字幕仍报绝对值
// - lane 碰撞求解：先推 x，同带内才微调 y，排序不反转；中心距 ≥ 半径和
// - memory mote 改 episode-local：全部被膜包住，泡内上下位置按自身 strength
import type { OceanSnapshot, VizMemory } from './types'
import { hash01, depthEase, WORLD, bubbleRadius } from './layout-core.mjs'

export { hash01, depthEase, WORLD }

export type PlacedMemory = {
  m: VizMemory
  x: number
  y: number
  r: number
  bleached: boolean
}

export type PlacedEpisode = {
  episode_id: string | null
  cx: number
  cy: number
  cr: number
  memories: PlacedMemory[]
}

const memTime = (m: VizMemory) => new Date(m.created_at).getTime()

// 四带（世界=图坐标）：水线 0.33 与珊瑚顶 0.80 来自 WORLD 带标
const BANDS = () => {
  const top = WORLD.beachEnd + 0.015
  const coral = WORLD.waterEnd
  const span = coral - top
  return {
    shallow: [top, top + span * 0.26] as const,          // pinned / 高强度
    mid: [top + span * 0.26, top + span * 0.56] as const, // 中强度
    deep: [top + span * 0.56, top + span * 0.86] as const, // 临近 fade
    coralBand: [top + span * 0.86, coral + 0.1] as const,  // 低于 fade_threshold：沉向珊瑚
  }
}

// 绝对深度：strength -> 世界 y（分段线性、单调递减于 strength）
const absoluteDepth = (s: number, ft: number, pinnedIn: boolean): number => {
  const B = BANDS()
  const lerp = (band: readonly [number, number], t: number) => band[0] + (band[1] - band[0]) * Math.min(1, Math.max(0, t))
  if (pinnedIn) return lerp(B.shallow, 0.25 * (1 - s))
  if (s < ft) return lerp(B.coralBand, (ft - s) / Math.max(ft, 1e-6))
  const hi = 0.66, mid = 0.33
  if (s >= hi) return lerp(B.shallow, (1 - s) / (1 - hi))
  if (s >= mid) return lerp(B.mid, (hi - s) / (hi - mid))
  return lerp(B.deep, (mid - s) / (mid - ft))
}

export const layoutOcean = (snap: OceanSnapshot): PlacedEpisode[] => {
  const eps = snap.episodes
  const ft = snap.fade_threshold
  const all = [...eps.flatMap((e) => e.memories), ...snap.loose]
  if (all.length === 0) return []
  const t0 = Math.min(...all.map(memTime)), t1 = Math.max(...all.map(memTime))
  const span = Math.max(1, t1 - t0)
  const timeX = (t: number) => 0.1 + ((t - t0) / span) * 0.8

  // episode 强度与绝对深度
  type Node = { episode_id: string; memories: VizMemory[]; s: number; pinnedIn: boolean; absD: number; x: number; y: number; r: number }
  const nodes: Node[] = eps.map((ep) => {
    const ss = ep.memories.map((m) => m.effective_strength)
    const s = 0.65 * Math.max(...ss) + 0.35 * (ss.reduce((a, b) => a + b, 0) / ss.length)
    const pinnedIn = ep.memories.some((m) => m.pinned)
    return { episode_id: ep.episode_id, memories: ep.memories, s, pinnedIn,
      absD: absoluteDepth(s, ft, pinnedIn), x: 0, y: 0, r: bubbleRadius(ep.memories.length) }
  })

  // percentile spread（单调；0.3 权重只拉开不改序）
  const sorted = [...nodes].sort((a, b) => a.absD - b.absD)
  const B = BANDS()
  const fullTop = B.shallow[0], fullBot = B.coralBand[1]
  sorted.forEach((n, i) => {
    const pct = sorted.length > 1 ? i / (sorted.length - 1) : 0.5
    const pctDepth = fullTop + pct * (fullBot - fullTop)
    n.y = 0.7 * n.absD + 0.3 * pctDepth
  })

  // 横向 lane（时间序稳定哈希）+ 碰撞求解：先推 x，同带内才微调 y（不反转排序）
  for (const n of nodes) {
    n.x = timeX(Math.min(...n.memories.map(memTime))) + (hash01(n.episode_id, 7) - 0.5) * 0.04
  }
  const placedNodes: Node[] = []
  const collides = (a: Node, x: number, y: number) =>
    placedNodes.some((b) => {
      const dx = (x - b.x), dy = (y - b.y) * 2.2   // 世界 y 权重放大（纵向挤压更敏感）
      return Math.hypot(dx, dy) < (a.r + b.r) * 1.15 + 0.012
    })
  for (const n of [...nodes].sort((a, b) => a.y - b.y)) {
    let bx = n.x, by = n.y, ok = !collides(n, bx, by)
    if (!ok) {
      outer: for (let dy = 0; dy <= 0.03 && !ok; dy += 0.01) {          // y 微调最后手段（同带内）
        for (let k = 1; k <= 14; k++) {                                  // x 优先左右交替推
          const cand = n.x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.045
          if (cand < 0.06 || cand > 0.94) continue
          if (!collides(n, cand, n.y + dy)) { bx = cand; by = n.y + dy; ok = true; break outer }
        }
      }
    }
    n.x = Math.min(0.94, Math.max(0.06, bx)); n.y = by
    placedNodes.push(n)
  }

  const placed: PlacedEpisode[] = placedNodes.map((n) => {
    // mote episode-local（七审 C）：全部包在膜内，泡内纵向位置按自身 strength 排列
    const byS = [...n.memories].sort((a, b) => b.effective_strength - a.effective_strength)
    const memories = byS.map((m, rank): PlacedMemory => {
      const bleached = !m.pinned && m.effective_strength < ft
      const ang = hash01(m.memory_id, 17) * Math.PI * 2
      const rad = Math.sqrt(hash01(m.memory_id, 19)) * n.r * 0.62
      const vertical = byS.length > 1 ? (rank / (byS.length - 1) - 0.5) * n.r * 1.1 : 0
      return { m, bleached,
        x: n.x + Math.cos(ang) * rad,
        y: n.y + vertical * 0.55 + Math.sin(ang) * rad * 0.4,
        r: 0.62 + m.effective_strength * 0.55 }
    })
    return { episode_id: n.episode_id, cx: n.x, cy: n.y, cr: n.r, memories }
  })

  if (snap.loose.length > 0) {
    // loose：无膜散粒，按自身强度独立落层；pinned 个体铺沙滩
    placed.push({ episode_id: null, cx: 0.5, cy: 0.5, cr: 0,
      memories: snap.loose.map((m): PlacedMemory => {
        const bleached = !m.pinned && m.effective_strength < ft
        if (m.pinned) {
          return { m, bleached: false,
            x: timeX(memTime(m)) + (hash01(m.memory_id, 3) - 0.5) * 0.04,
            y: WORLD.skyEnd + 0.02 + hash01(m.memory_id, 5) * (WORLD.beachEnd - WORLD.skyEnd - 0.05),
            r: 1 }
        }
        return { m, bleached,
          x: Math.min(0.94, Math.max(0.06, timeX(memTime(m)) + (hash01(m.memory_id, 11) - 0.5) * 0.08)),
          y: absoluteDepth(m.effective_strength, ft, false) + (hash01(m.memory_id, 13) - 0.5) * 0.015,
          r: 0.62 + m.effective_strength * 0.55 }
      }) })
  }
  return placed
}
