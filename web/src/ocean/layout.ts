// 布局映射（DESIGN-OCEAN.md 契约 #1/#4）：
//   纵轴 = 生命周期：visual_depth = 1 - effective_strength，经 easing 展开浅水区
//   横轴 = 时间：episode 首条记忆 created_at 归一化；同座标扰动用【稳定哈希】不用随机数
import type { OceanSnapshot, VizMemory } from './types'

// FNV-1a：同一 id 每次刷新落在同一位置（契约#4——扰动可复现）
export const hash01 = (s: string, salt = 0): number => {
  let h = 0x811c9dc5 ^ salt
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0) / 0xffffffff
}

// 深度 easing：pow(0.72) 把高强度段拉开，让"还记得清楚的"在画面里有层次
export const depthEase = (d: number): number => Math.pow(Math.min(1, Math.max(0, d)), 0.72)

// 画面纵向分带（她的手稿：奶油天空→沙滩→水体→白化珊瑚海床）
export const BANDS = {
  skyEnd: 0.16,
  beachEnd: 0.30,      // pinned 的家：重要记忆浮在最上面的沙滩
  waterEnd: 0.86,      // 水体 = 活着的记忆按深度悬浮
  // 0.86 以下 = 海床白化珊瑚区：effective_strength < fade_threshold 的记忆沉在这
}

export type PlacedMemory = {
  m: VizMemory
  x: number            // 0..1
  y: number            // 0..1
  r: number            // 基础半径（px 无关，画布内再乘）
  bleached: boolean    // 低于水线 → 白化
}

export type PlacedEpisode = {
  episode_id: string
  cx: number           // 气泡中心
  cy: number
  cr: number           // 气泡膜半径
  memories: PlacedMemory[]
}

export const layoutOcean = (snap: OceanSnapshot): PlacedEpisode[] => {
  const eps = snap.episodes
  if (eps.length === 0) return []
  const epTime = (e: { memories: VizMemory[] }) =>
    Math.min(...e.memories.map((m) => new Date(m.created_at).getTime()))
  const times = eps.map(epTime)
  const t0 = Math.min(...times), t1 = Math.max(...times)
  const span = Math.max(1, t1 - t0)

  return eps.map((ep) => {
    const tx = (epTime(ep) - t0) / span
    // 横向留边 8%，稳定哈希抖动避免同刻 episode 重叠
    const cx = 0.08 + tx * 0.84 + (hash01(ep.episode_id, 7) - 0.5) * 0.05
    const strengths = ep.memories.filter((m) => !m.pinned).map((m) => m.effective_strength)
    const meanStrength = strengths.length
      ? strengths.reduce((a, b) => a + b, 0) / strengths.length : 1
    const meanDepth = depthEase(1 - meanStrength)
    const cy = BANDS.beachEnd + meanDepth * (BANDS.waterEnd - BANDS.beachEnd)
    const cr = 0.035 + Math.min(0.05, ep.memories.length * 0.006)

    const memories = ep.memories.map((m): PlacedMemory => {
      const bleached = !m.pinned && m.effective_strength < snap.fade_threshold
      if (m.pinned) {
        // 沙滩：横向按自身时间散布，纵向压在沙带内
        return { m, bleached: false,
          x: 0.08 + hash01(m.memory_id, 3) * 0.84,
          y: BANDS.skyEnd + 0.02 + hash01(m.memory_id, 5) * (BANDS.beachEnd - BANDS.skyEnd - 0.05),
          r: 1 }
      }
      if (bleached) {
        // 海床：沉底，微微起伏
        return { m, bleached: true,
          x: Math.min(0.95, Math.max(0.05, cx + (hash01(m.memory_id, 11) - 0.5) * 0.16)),
          y: BANDS.waterEnd + 0.03 + hash01(m.memory_id, 13) * (0.97 - BANDS.waterEnd - 0.03),
          r: 0.8 }
      }
      // 水中：围绕气泡中心的极座标散布（稳定哈希），自身深度参与纵向偏移
      const ang = hash01(m.memory_id, 17) * Math.PI * 2
      const rad = Math.sqrt(hash01(m.memory_id, 19)) * cr * 0.75
      const ownDepth = depthEase(1 - m.effective_strength)
      const y = BANDS.beachEnd + ownDepth * (BANDS.waterEnd - BANDS.beachEnd)
      return { m, bleached: false,
        x: Math.min(0.95, Math.max(0.05, cx + Math.cos(ang) * rad)),
        y: Math.min(BANDS.waterEnd, Math.max(BANDS.beachEnd + 0.01, y * 0.6 + (cy + Math.sin(ang) * rad * 0.8) * 0.4)),
        r: 0.7 + m.effective_strength * 0.6 }
    })
    return { episode_id: ep.episode_id, cx, cy, cr, memories }
  })
}
