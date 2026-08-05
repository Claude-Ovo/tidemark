// 调色 v2：以她的 GPT 全景参考图（ovo.jpg）为基准、整体降饱和 30%（她的钦定参数）。
// 蓝天白云 + 淡金沙 + 青绿浅水 -> 宝蓝 -> 深海蓝紫；白化珊瑚带紫晕背光。
// kind 是自由字符串，常见 kind 固定色、未知 kind 稳定哈希取色相——同 kind 永远同色。
import { hash01 } from './layout-core.mjs'

export const SKY = ['#a9c9e6', '#8fb5d9'] as const          // 参考图的蓝天，降饱和
export const CLOUD = '#f4f8fb'
export const SAND = ['#e9dab2', '#d9c492'] as const          // 淡金沙滩
export const WATER = ['#7cc4cc', '#4f9dc2', '#3b6da6', '#2a4a7e', '#1d3260'] as const
export const SEABED = '#141f42'                              // 深海蓝紫
export const CORAL_BLEACHED = '#e6e0d4'
export const CORAL_GLOW = '#8a7ab8'                          // 珊瑚背光紫晕（参考图海床）
export const FISH = '#243a5e'                                // 鱼群剪影（深蓝，非纯黑）
export const GOLD_DUST = '#d9b86a'                           // 金色光尘（银河鱼群参考图）
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
