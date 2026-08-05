// 海景画布 v0：2D painterly 高斯泼溅感——半透明椭圆色粒、碎化柔边、亮色 bloom。
// 铁律：零方框零按钮（悬停高亮在粒子本体上做）；本文件只负责"画"，
// 强度/深度全部来自服务端快照（契约#1/#2），动画只做视觉呼吸不做衰减。
import { useEffect, useRef } from 'react'
import type { OceanSnapshot } from './types'
import { layoutOcean, BANDS, hash01, type PlacedEpisode } from './layout'
import { SKY, SAND, WATER, SEABED, CORAL_BLEACHED, FOAM, memoryColor, pearlColor } from './palette'

export type HoverInfo = { memory_id: string; episode_id: string; kind: string | null
  strength: number; pinned: boolean; bleached: boolean; preview: string; sx: number; sy: number }
export type FoamWave = { request_id: string; episode_id: string; arrivedAt: number }

type Props = { snap: OceanSnapshot; waves: FoamWave[]; onHover: (h: HoverInfo | null) => void }

// 淡出必须淡向【同色 alpha=0】——CSS 'transparent' 是 rgba(0,0,0,0)，
// 渐变会朝黑色插值，给每枚色粒镶一圈脏黑晕（首屏截图实锤过）
const fade = (c: string): string =>
  c.startsWith('#') ? c + '00'
  : c.startsWith('hsl(') ? c.replace(')', ' / 0)')
  : c.replace(/[\d.]+\)\s*$/, '0)')

const splat = (ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number,
  rot: number, color: string, alpha: number, lighter = false) => {
  ctx.save()
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, ry / rx)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  g.addColorStop(0, color); g.addColorStop(0.62, color); g.addColorStop(1, fade(color))
  ctx.globalAlpha = alpha
  if (lighter) ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = g
  ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

// 背景一次性铺陈：基底渐变 + 数百枚确定性大色粒（印象派分层），resize 才重画
const paintBackdrop = (c: HTMLCanvasElement) => {
  const ctx = c.getContext('2d')!
  const W = c.width, H = c.height
  const lg = ctx.createLinearGradient(0, 0, 0, H)
  lg.addColorStop(0, SKY[0]); lg.addColorStop(BANDS.skyEnd, SKY[1])
  lg.addColorStop(BANDS.skyEnd + 0.01, SAND[0]); lg.addColorStop(BANDS.beachEnd, SAND[1])
  lg.addColorStop(BANDS.beachEnd + 0.01, WATER[0]); lg.addColorStop(0.5, WATER[1])
  lg.addColorStop(0.68, WATER[2]); lg.addColorStop(BANDS.waterEnd, WATER[3])
  lg.addColorStop(1, SEABED)
  ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H)
  const bandColor = (v: number): string =>
    v < BANDS.skyEnd ? SKY[1] : v < BANDS.beachEnd ? SAND[Math.floor(hash01(String(v), 2) * 2)]
    : v < 0.5 ? WATER[0] : v < 0.68 ? WATER[1] : v < BANDS.waterEnd ? WATER[2] : WATER[3]
  for (let i = 0; i < 420; i++) {
    const y = hash01(`bg${i}`, 31)
    const x = hash01(`bg${i}`, 37)
    splat(ctx, x * W, y * H, (0.04 + hash01(`bg${i}`, 41) * 0.09) * W,
      (0.012 + hash01(`bg${i}`, 43) * 0.03) * H, (hash01(`bg${i}`, 47) - 0.5) * 0.9,
      bandColor(y), 0.05 + hash01(`bg${i}`, 53) * 0.08)
  }
  // 天光 bloom
  splat(ctx, W * 0.5, H * 0.04, W * 0.3, H * 0.07, 0, '#fff6e0', 0.5, true)
  // 白化珊瑚海床：几株碎片化分枝
  for (let k = 0; k < 6; k++) {
    const bx = (0.1 + k * 0.16 + hash01(`c${k}`, 59) * 0.06) * W
    const by = H * (0.965 - hash01(`c${k}`, 61) * 0.02)
    for (let b = 0; b < 12; b++) {
      const t = b / 12
      const ang = -Math.PI / 2 + (hash01(`c${k}b${b}`, 67) - 0.5) * 1.7
      splat(ctx, bx + Math.cos(ang) * t * 0.07 * W, by + Math.sin(ang) * t * 0.1 * H,
        0.013 * W * (1 - t * 0.5), 0.01 * W * (1 - t * 0.5),
        hash01(`c${k}b${b}`, 71) * 3, CORAL_BLEACHED, 0.6 - t * 0.3)
    }
  }
  // 装饰棕榈（她手稿上方的树）：两簇泼溅叶冠
  for (const [tx, flip] of [[0.06, 1], [0.93, -1]] as const) {
    const px = tx * W, py = H * (BANDS.skyEnd + 0.015)
    splat(ctx, px, py, 0.006 * W, 0.05 * H, 0.12 * flip, '#7a5a3a', 0.55)
    for (let f = 0; f < 7; f++) {
      const ang = -Math.PI / 2 + (f - 3) * 0.42
      splat(ctx, px + Math.cos(ang) * 0.035 * W * flip, py - 0.05 * H + Math.sin(ang) * 0.03 * H,
        0.03 * W, 0.008 * H, ang * flip * 0.5, f % 2 ? '#4e7d54' : '#6a9c68', 0.45)
    }
  }
}

export const OceanCanvas = ({ snap, waves, onHover }: Props) => {
  const bgRef = useRef<HTMLCanvasElement>(null)
  const fgRef = useRef<HTMLCanvasElement>(null)
  const placedRef = useRef<PlacedEpisode[]>([])
  const hoverIdRef = useRef<string | null>(null)
  const reduced = useRef(false)

  useEffect(() => {
    placedRef.current = layoutOcean(snap)
  }, [snap])

  useEffect(() => {
    const bg = bgRef.current!, fg = fgRef.current!
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      for (const c of [bg, fg]) {
        c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr)
      }
      paintBackdrop(bg)
    }
    fit()
    const ro = new ResizeObserver(fit); ro.observe(fg)

    const ctx = fg.getContext('2d')!
    let raf = 0
    const frame = (t: number) => {
      const W = fg.width, H = fg.height
      ctx.clearRect(0, 0, W, H)
      const bob = (id: string, amp: number) =>
        reduced.current ? 0 : Math.sin(t / 2600 + hash01(id, 73) * 6.28) * amp * H
      for (const ep of placedRef.current) {
        // 气泡膜：碎化环 + 高光弧
        const cx = ep.cx * W, cy = ep.cy * H + bob(ep.episode_id, 0.004), cr = ep.cr * W
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2
          splat(ctx, cx + Math.cos(a) * cr, cy + Math.sin(a) * cr,
            cr * 0.22, cr * 0.1, a, 'rgba(230,248,250,0.9)', 0.075)
        }
        ctx.save(); ctx.globalAlpha = 0.28; ctx.strokeStyle = 'rgba(240,252,255,0.8)'
        ctx.lineWidth = Math.max(1, cr * 0.045)
        ctx.beginPath(); ctx.arc(cx, cy, cr * 0.96, -2.2, -0.9); ctx.stroke(); ctx.restore()
      }
      for (const ep of placedRef.current) {
        for (const p of ep.memories) {
          const x = p.x * W, y = p.y * H + bob(p.m.memory_id, p.bleached ? 0.001 : 0.003)
          const base = (p.m.layer === 'experience' ? 9 : 7) * p.r * (W / 1400)
          const hovered = hoverIdRef.current === p.m.memory_id
          const color = p.m.layer === 'experience'
            ? pearlColor(p.m.exp_status)
            : memoryColor(p.m.kind, p.m.effective_strength, p.bleached)
          // bloom 底光 → 碎化椭圆簇 → 亮核
          splat(ctx, x, y, base * 3.2, base * 2.2, 0, color, p.bleached ? 0.05 : 0.13, true)
          for (let i = 0; i < 6; i++) {
            splat(ctx, x + (hash01(p.m.memory_id + i, 79) - 0.5) * base * 1.6,
              y + (hash01(p.m.memory_id + i, 83) - 0.5) * base * 1.2,
              base * (0.75 + hash01(p.m.memory_id + i, 89) * 0.6),
              base * (0.4 + hash01(p.m.memory_id + i, 97) * 0.4),
              hash01(p.m.memory_id + i, 101) * 3.1, color, p.bleached ? 0.16 : 0.26)
          }
          splat(ctx, x, y, base * 0.65, base * 0.5, 0.4, '#ffffff', p.bleached ? 0.1 : 0.28, true)
          if (p.m.layer === 'experience') // 珍珠高光点
            splat(ctx, x - base * 0.25, y - base * 0.25, base * 0.22, base * 0.18, 0, '#ffffff', 0.75, true)
          if (hovered) // 悬停 = 粒子自己变亮变大（零方框）
            splat(ctx, x, y, base * 4.4, base * 3.2, 0, color, 0.22, true)
        }
      }
      // 浪：persisted receipt 到岸的泡沫痕（4 秒消散）
      const nowT = performance.now()
      for (const w of waves) {
        const age = (nowT - w.arrivedAt) / 4000
        if (age >= 1) continue
        const ep = placedRef.current.find((e) => e.episode_id === w.episode_id)
        const fx = (ep ? ep.cx : hash01(w.request_id, 103)) * W
        const fy = BANDS.beachEnd * H
        const spread = (0.03 + age * 0.1) * W
        for (let i = 0; i < 9; i++) {
          splat(ctx, fx + (i - 4) * spread * 0.25, fy + Math.sin(i * 1.7 + age * 9) * 0.006 * H,
            spread * 0.3, 0.005 * H, 0, FOAM, (1 - age) * 0.4, true)
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [waves])

  const findHit = (e: React.PointerEvent): HoverInfo | null => {
    const fg = fgRef.current!
    const rect = fg.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width, my = (e.clientY - rect.top) / rect.height
    let best: HoverInfo | null = null, bestD = 0.0009  // ~命中半径 3% 画幅
    for (const ep of placedRef.current) for (const p of ep.memories) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2
      if (d < bestD) {
        bestD = d
        best = { memory_id: p.m.memory_id, episode_id: ep.episode_id, kind: p.m.kind,
          strength: p.m.effective_strength, pinned: p.m.pinned, bleached: p.bleached,
          preview: p.m.content_preview, sx: e.clientX - rect.left, sy: e.clientY - rect.top }
      }
    }
    return best
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}
      onPointerMove={(e) => { const h = findHit(e); hoverIdRef.current = h?.memory_id ?? null; onHover(h) }}
      onPointerLeave={() => { hoverIdRef.current = null; onHover(null) }}>
      <canvas ref={bgRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <canvas ref={fgRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </div>
  )
}
