// 调色：她手稿的奶油→青→深蓝纵向渐变；kind 是自由字符串，常见 kind 固定色、
// 未知 kind 用稳定哈希取色相——同一 kind 永远同一种颜色
import { hash01 } from './layout-core.mjs'

export const SKY = ['#f6ead8', '#f0dcc0'] as const
export const SAND = ['#eccfa2', '#dfb98a'] as const
export const WATER = ['#8fd8d4', '#4fb3bd', '#2e7f96', '#173a5c', '#0d1f38'] as const
export const SEABED = '#0b1830'
export const CORAL_BLEACHED = '#ded8cc'
export const FOAM = 'rgba(255, 250, 240, 0.85)'

const KNOWN_KIND_HUES: Record<string, number> = {
  fact: 195,        // 青
  preference: 335,  // 珊瑚粉
  decision: 268,    // 紫
  skill: 152,       // 海松绿
  event: 28,        // 暖橙
  note: 210,
}

export const kindHue = (kind: string | null): number =>
  kind == null ? 210 : (KNOWN_KIND_HUES[kind] ?? Math.floor(hash01(kind, 23) * 360))

// 记忆粒子主色：强度调饱和与亮度，白化则整体褪成珊瑚白
export const memoryColor = (kind: string | null, strength: number, bleached: boolean): string => {
  if (bleached) return CORAL_BLEACHED
  const h = kindHue(kind)
  const s = 30 + strength * 45
  const l = 52 + strength * 20
  return `hsl(${h} ${s}% ${l}%)`
}

// experience 珍珠光泽：verified 亮银、candidate 温白、superseded 灰
export const pearlColor = (exp: string | null): string =>
  exp === 'verified' ? '#f2f6f4' : exp === 'candidate' ? '#e9e2d4' : '#9aa1a8'
