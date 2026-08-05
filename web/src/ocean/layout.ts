// 布局映射（DESIGN-OCEAN.md 契约 #1/#4，一审修订：loose 散粒 + sqrt 气泡半径）。
// 纯函数在 layout-core.mjs（node 直测）；这里做类型化的场景组装。
import type { OceanSnapshot, VizMemory } from './types'
import { hash01, depthEase, WORLD, bubbleRadius } from './layout-core.mjs'

export { hash01, depthEase, WORLD }

export type PlacedMemory = {
  m: VizMemory
  x: number            // 0..1 世界横轴
  y: number            // 0..1 世界纵轴（0=天顶 1=海底）
  r: number            // 基础半径系数
  bleached: boolean    // 低于 fade_threshold -> 海床白化
}

export type PlacedEpisode = {
  episode_id: string | null   // null = loose 散粒容器（不画膜，一审 P1-3）
  cx: number
  cy: number
  cr: number
  memories: PlacedMemory[]
}

const memTime = (m: VizMemory) => new Date(m.created_at).getTime()

export const layoutOcean = (snap: OceanSnapshot): PlacedEpisode[] => {
  const all = [...snap.episodes.flatMap((e) => e.memories), ...snap.loose]
  if (all.length === 0) return []
  const t0 = Math.min(...all.map(memTime)), t1 = Math.max(...all.map(memTime))
  const span = Math.max(1, t1 - t0)
  const timeX = (t: number) => 0.08 + ((t - t0) / span) * 0.84
  const waterSpan = WORLD.waterEnd - WORLD.beachEnd

  const placeOne = (m: VizMemory, cx: number, cr: number, bleachThreshold: number): PlacedMemory => {
    const bleached = !m.pinned && m.effective_strength < bleachThreshold
    if (m.pinned) {
      // 沙滩：pinned 铺在沙带，横向按自身时间，纵向哈希微散
      return { m, bleached: false,
        x: timeX(memTime(m)) + (hash01(m.memory_id, 3) - 0.5) * 0.04,
        y: WORLD.skyEnd + 0.008 + hash01(m.memory_id, 5) * (WORLD.beachEnd - WORLD.skyEnd - 0.02),
        r: 1 }
    }
    if (bleached) {
      // 海床：沉底白化，微微起伏
      return { m, bleached: true,
        x: Math.min(0.95, Math.max(0.05, cx + (hash01(m.memory_id, 11) - 0.5) * 0.14)),
        y: WORLD.waterEnd + 0.02 + hash01(m.memory_id, 13) * (0.96 - WORLD.waterEnd - 0.02),
        r: 0.8 }
    }
    // 水中：深度由自身强度定（契约#1），围绕气泡心极座标散布
    const ang = hash01(m.memory_id, 17) * Math.PI * 2
    const rad = Math.sqrt(hash01(m.memory_id, 19)) * cr * 0.8
    const y = WORLD.beachEnd + depthEase(1 - m.effective_strength) * waterSpan
    return { m, bleached: false,
      x: Math.min(0.95, Math.max(0.05, cx + Math.cos(ang) * rad)),
      y: Math.min(WORLD.waterEnd, Math.max(WORLD.beachEnd + 0.005, y + Math.sin(ang) * rad * 0.35)),
      r: 0.7 + m.effective_strength * 0.6 }
  }

  const placed: PlacedEpisode[] = snap.episodes.map((ep) => {
    const cx = timeX(Math.min(...ep.memories.map(memTime)))
      + (hash01(ep.episode_id ?? '', 7) - 0.5) * 0.05
    const live = ep.memories.filter((m) => !m.pinned)
    const meanStrength = live.length
      ? live.reduce((a, b) => a + b.effective_strength, 0) / live.length : 1
    const cy = WORLD.beachEnd + depthEase(1 - meanStrength) * waterSpan
    const cr = bubbleRadius(ep.memories.length)
    return { episode_id: ep.episode_id, cx, cy, cr,
      memories: ep.memories.map((m) => placeOne(m, cx, cr, snap.fade_threshold)) }
  })
  if (snap.loose.length > 0) {
    // loose：无膜散粒，各自按自己的时间与深度独立漂（绝不合成假气泡）
    placed.push({ episode_id: null, cx: 0.5, cy: 0.5, cr: 0,
      memories: snap.loose.map((m) => placeOne(m, timeX(memTime(m)), 0.04, snap.fade_threshold)) })
  }
  return placed
}
