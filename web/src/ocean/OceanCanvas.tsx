// 海景画布 v1：世界坐标 4.5 屏深，滚动=下潜（相机进 ref 不进 state）。
// 一审动效修订全落在这：
//   A. 渲染循环单例——mount 建一次；snap/waves/camera 全走 ref 同步，绝不重建 rAF/backdrop
//   B. reduced-motion 真静态——呼吸停 + 空闲帧跳过绘制（脏帧标记），浪降级为静态潮痕
//   C. 悬停不打 React state——字幕内容仅在 memory_id 变化时 setState 一次，
//      跟随坐标直接写 DOM transform；连续指针值零 rerender
// 铁律不变：零方框零按钮；强度/深度全来自服务端快照，动画只做视觉呼吸不做衰减。
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { OceanSnapshot } from './types'
import { layoutOcean, type PlacedEpisode } from './layout'
import { hash01, WORLD, splatsPerMemory } from './layout-core.mjs'
import { SKY, SAND, WATER, SEABED, CORAL_BLEACHED, FOAM, memoryColor, pearlColor } from './palette'

export type FoamWave = { request_id: string; episode_id: string | null; arrivedAt: number }
type Caption = { pinned: boolean; bleached: boolean; kind: string | null; strength: number; preview: string }
type Props = { snap: OceanSnapshot; waves: FoamWave[]; cameraRef: RefObject<number> }

// 淡出必须淡向【同色 alpha=0】——CSS 'transparent' 是 rgba(0,0,0,0)，
// 渐变会朝黑色插值，给每枚色粒镶一圈脏黑晕（v0 首屏截图实锤过）
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

// 世界级背景一次性铺陈（resize 才重画）：整片海 4.5 屏高的 offscreen，逐帧按相机裁剪位块
const paintBackdrop = (c: HTMLCanvasElement, W: number, WORLD_H: number) => {
  const ctx = c.getContext('2d')!
  const lg = ctx.createLinearGradient(0, 0, 0, WORLD_H)
  lg.addColorStop(0, SKY[0]); lg.addColorStop(WORLD.skyEnd, SKY[1])
  lg.addColorStop(WORLD.skyEnd + 0.004, SAND[0]); lg.addColorStop(WORLD.beachEnd, SAND[1])
  lg.addColorStop(WORLD.beachEnd + 0.004, WATER[0]); lg.addColorStop(0.34, WATER[1])
  lg.addColorStop(0.55, WATER[2]); lg.addColorStop(WORLD.waterEnd, WATER[3])
  lg.addColorStop(1, SEABED)
  ctx.fillStyle = lg; ctx.fillRect(0, 0, W, WORLD_H)
  const bandColor = (v: number): string =>
    v < WORLD.skyEnd ? SKY[1] : v < WORLD.beachEnd ? SAND[Math.floor(hash01(String(v), 2) * 2)]
    : v < 0.34 ? WATER[0] : v < 0.55 ? WATER[1] : v < WORLD.waterEnd ? WATER[2] : WATER[3]
  for (let i = 0; i < 780; i++) {
    const y = hash01(`bg${i}`, 31)
    splat(ctx, hash01(`bg${i}`, 37) * W, y * WORLD_H, (0.04 + hash01(`bg${i}`, 41) * 0.09) * W,
      (0.01 + hash01(`bg${i}`, 43) * 0.022) * WORLD_H, (hash01(`bg${i}`, 47) - 0.5) * 0.9,
      bandColor(y), 0.05 + hash01(`bg${i}`, 53) * 0.08)
  }
  // 天光 bloom + 沙水线泡沫
  splat(ctx, W * 0.5, WORLD_H * 0.012, W * 0.3, WORLD_H * 0.02, 0, '#fff6e0', 0.5, true)
  for (let i = 0; i < 26; i++) {
    splat(ctx, hash01(`fm${i}`, 57) * W, WORLD_H * (WORLD.beachEnd + (hash01(`fm${i}`, 58) - 0.5) * 0.004),
      0.05 * W, 0.0012 * WORLD_H, 0, FOAM, 0.16, true)
  }
  // 光衰：越深越暗（先压暗——荧光与珊瑚必须画在黑暗【上面】才透得出来；
  // 首版把覆盖层画在最后，白化珊瑚被闷成泥色，像素采样实锤后重排）
  const dk = ctx.createLinearGradient(0, WORLD_H * 0.5, 0, WORLD_H)
  dk.addColorStop(0, 'rgba(4,10,24,0)'); dk.addColorStop(1, 'rgba(4,10,24,0.5)')
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = dk; ctx.fillRect(0, WORLD_H * 0.5, W, WORLD_H * 0.5)
  // 深水微光（生物荧光点）+ 海雪（深带质感，全确定性）
  for (let i = 0; i < 46; i++) {
    const y = 0.5 + hash01(`gl${i}`, 107) * 0.3
    splat(ctx, hash01(`gl${i}`, 109) * W, y * WORLD_H, 0.004 * W, 0.003 * W,
      0, i % 3 ? '#7fd4d4' : '#b7e6c9', 0.2, true)
  }
  for (let i = 0; i < 34; i++) {
    const y = 0.42 + hash01(`sn${i}`, 111) * 0.52
    splat(ctx, hash01(`sn${i}`, 113) * W, y * WORLD_H, 0.0016 * W, 0.0012 * W,
      0, '#e8f2f2', 0.1, true)
  }
  // 白化珊瑚海床：分枝簇（概念锚点，必须清晰可读）
  for (let k = 0; k < 8; k++) {
    const bx = (0.06 + k * 0.12 + hash01(`c${k}`, 59) * 0.05) * W
    const by = WORLD_H * (0.985 - hash01(`c${k}`, 61) * 0.008)
    for (let b = 0; b < 14; b++) {
      const t = b / 14
      const ang = -Math.PI / 2 + (hash01(`c${k}b${b}`, 67) - 0.5) * 1.7
      splat(ctx, bx + Math.cos(ang) * t * 0.06 * W, by + Math.sin(ang) * t * 0.028 * WORLD_H,
        0.012 * W * (1 - t * 0.5), 0.009 * W * (1 - t * 0.5),
        hash01(`c${k}b${b}`, 71) * 3, CORAL_BLEACHED, 0.78 - t * 0.32)
    }
  }
  // 装饰棕榈（她手稿上方的树）
  for (const [tx, flip] of [[0.06, 1], [0.93, -1]] as const) {
    const px = tx * W, py = WORLD_H * (WORLD.skyEnd + 0.003)
    splat(ctx, px, py, 0.006 * W, 0.011 * WORLD_H, 0.12 * flip, '#7a5a3a', 0.55)
    for (let f = 0; f < 7; f++) {
      const ang = -Math.PI / 2 + (f - 3) * 0.42
      splat(ctx, px + Math.cos(ang) * 0.035 * W * flip, py - 0.011 * WORLD_H + Math.sin(ang) * 0.007 * WORLD_H,
        0.03 * W, 0.008 * W, ang * flip * 0.5, f % 2 ? '#4e7d54' : '#6a9c68', 0.45)
    }
  }
}

export const OceanCanvas = ({ snap, waves, cameraRef }: Props) => {
  const cvsRef = useRef<HTMLCanvasElement>(null)
  const capRef = useRef<HTMLDivElement>(null)
  const placedRef = useRef<PlacedEpisode[]>([])
  const snapDirtyRef = useRef(true)
  const wavesRef = useRef<FoamWave[]>([])
  const hoverIdRef = useRef<string | null>(null)
  const [caption, setCaption] = useState<Caption | null>(null)

  // 数据经 ref 进入渲染循环（动效A：绝不作为 effect 依赖重建循环）
  useEffect(() => { placedRef.current = layoutOcean(snap); snapDirtyRef.current = true }, [snap])
  useEffect(() => { wavesRef.current = waves; snapDirtyRef.current = true }, [waves])

  useEffect(() => {
    const cvs = cvsRef.current!
    const ctx = cvs.getContext('2d')!
    const bg = document.createElement('canvas')
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = mq.matches
    const onMq = () => { reduced = mq.matches; snapDirtyRef.current = true }
    mq.addEventListener('change', onMq)

    let W = 0, H = 0, WORLD_H = 0
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      W = Math.round(cvs.clientWidth * dpr); H = Math.round(cvs.clientHeight * dpr)
      cvs.width = W; cvs.height = H
      WORLD_H = Math.round(H * WORLD.DEPTH_SCALE)
      bg.width = W; bg.height = WORLD_H
      paintBackdrop(bg, W, WORLD_H)
      snapDirtyRef.current = true
    }
    fit()
    const ro = new ResizeObserver(fit); ro.observe(cvs)

    let cam = cameraRef.current ?? 0
    let lastPaintedCam = -1
    let hadActiveWaves = false
    let raf = 0
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame)
      const target = cameraRef.current ?? 0
      // 相机平滑（梦感滞后）；reduced 下直达不飘
      cam = reduced ? target : cam + (target - cam) * 0.14
      if (Math.abs(target - cam) < 0.0004) cam = target
      const nowT = performance.now()
      const activeWaves = wavesRef.current.some((w) => nowT - w.arrivedAt < 4200)
      // 动效B：reduced 时空闲帧完全不碰画布；浪的收场帧靠 hadActiveWaves 补一笔
      const mustPaint = !reduced
        || snapDirtyRef.current || cam !== lastPaintedCam || activeWaves || hadActiveWaves
      hadActiveWaves = activeWaves
      if (!mustPaint) return
      snapDirtyRef.current = false
      lastPaintedCam = cam

      const camOff = cam * (WORLD_H - H)
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(bg, 0, camOff, W, H, 0, 0, W, H)
      const bob = (id: string, amp: number) =>
        reduced ? 0 : Math.sin(t / 2600 + hash01(id, 73) * 6.28) * amp * H
      const sy = (worldY: number, b = 0) => worldY * WORLD_H - camOff + b
      const onScreen = (y: number, m = 80) => y > -m && y < H + m

      for (const ep of placedRef.current) {
        if (ep.episode_id === null || ep.cr === 0) continue   // loose 散粒无膜（一审 P1-3）
        const cx = ep.cx * W, cy = sy(ep.cy, bob(ep.episode_id, 0.004)), cr = ep.cr * W
        if (!onScreen(cy, cr + 80)) continue
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
        const lod = splatsPerMemory(ep.memories.length)   // 一审 P1-6：密度降档
        for (const p of ep.memories) {
          const amp = p.m.pinned ? 0 : p.bleached ? 0.001 : 0.003   // 岸上不漂，海床微动
          const x = p.x * W, y = sy(p.y, bob(p.m.memory_id, amp))
          if (!onScreen(y)) continue
          const base = (p.m.layer === 'experience' ? 9 : 7) * p.r * (W / 1400)
          const hovered = hoverIdRef.current === p.m.memory_id
          const color = p.m.layer === 'experience'
            ? pearlColor(p.m.exp_status)
            : memoryColor(p.m.kind, p.m.effective_strength, p.bleached)
          splat(ctx, x, y, base * 3.2, base * 2.2, 0, color, p.bleached ? 0.05 : 0.13, true)
          for (let i = 0; i < lod; i++) {
            splat(ctx, x + (hash01(p.m.memory_id + i, 79) - 0.5) * base * 1.6,
              y + (hash01(p.m.memory_id + i, 83) - 0.5) * base * 1.2,
              base * (0.75 + hash01(p.m.memory_id + i, 89) * 0.6),
              base * (0.4 + hash01(p.m.memory_id + i, 97) * 0.4),
              hash01(p.m.memory_id + i, 101) * 3.1, color, p.bleached ? 0.16 : 0.26)
          }
          splat(ctx, x, y, base * 0.65, base * 0.5, 0.4, '#ffffff', p.bleached ? 0.1 : 0.28, true)
          if (p.m.layer === 'experience')
            splat(ctx, x - base * 0.25, y - base * 0.25, base * 0.22, base * 0.18, 0, '#ffffff', 0.75, true)
          if (hovered)
            splat(ctx, x, y, base * 4.4, base * 3.2, 0, color, 0.22, true)
        }
      }
      // 浪：persisted receipt 的泡沫痕；reduced 下静态潮痕（不扩散），4 秒后消失
      for (const w of wavesRef.current) {
        const age = (nowT - w.arrivedAt) / 4000
        if (age >= 1) continue
        const ep = w.episode_id ? placedRef.current.find((e) => e.episode_id === w.episode_id) : null
        const fx = (ep ? ep.cx : hash01(w.request_id, 103)) * W
        const fy = sy(WORLD.beachEnd)
        if (!onScreen(fy)) continue
        const prog = reduced ? 0.5 : age
        const spread = (0.03 + prog * 0.1) * W
        for (let i = 0; i < 9; i++) {
          splat(ctx, fx + (i - 4) * spread * 0.25,
            fy + (reduced ? 0 : Math.sin(i * 1.7 + age * 9) * 0.0012 * WORLD_H),
            spread * 0.3, 0.0011 * WORLD_H, 0, FOAM, (1 - age) * 0.4, true)
        }
      }
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mq.removeEventListener('change', onMq) }
  }, [])   // 单例循环：依赖为空是设计（动效A），数据全走 ref

  // 动效C：hit-test 每次指针动都跑（纯计算），但 setState 只在悬停对象变化时发生；
  // 字幕跟随坐标绕开 React，直接写 transform
  const onMove = (e: React.PointerEvent) => {
    const rect = cvsRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const cam = cameraRef.current ?? 0
    const worldH = rect.height * WORLD.DEPTH_SCALE
    const camOff = cam * (worldH - rect.height)
    let hit: { id: string; c: Caption } | null = null, bestD = 26 * 26
    for (const ep of placedRef.current) for (const p of ep.memories) {
      const dx = p.x * rect.width - mx, dy = p.y * worldH - camOff - my
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        hit = { id: p.m.memory_id, c: { pinned: p.m.pinned, bleached: p.bleached,
          kind: p.m.kind, strength: p.m.effective_strength, preview: p.m.content_preview } }
      }
    }
    if (capRef.current) {
      capRef.current.style.transform = `translate(${mx + 14}px, ${my - 10}px)`
      capRef.current.style.opacity = hit ? '1' : '0'
    }
    if ((hit?.id ?? null) !== hoverIdRef.current) {
      hoverIdRef.current = hit?.id ?? null
      snapDirtyRef.current = true
      if (hit) setCaption(hit.c)
    }
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}
      onPointerMove={onMove}
      onPointerLeave={() => {
        hoverIdRef.current = null; snapDirtyRef.current = true
        if (capRef.current) capRef.current.style.opacity = '0'
      }}>
      <canvas ref={cvsRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <div ref={capRef} style={{
        position: 'absolute', left: 0, top: 0, maxWidth: 300, opacity: 0,
        pointerEvents: 'none', color: '#fdfbf5', fontSize: 13, lineHeight: 1.5,
        transition: 'opacity 0.25s',
        textShadow: '0 0 6px rgba(6,20,40,0.95), 0 0 18px rgba(6,20,40,0.85), 0 0 34px rgba(6,20,40,0.7)',
      }}>
        {caption && (<>
          <em style={{ opacity: 0.85 }}>
            {caption.pinned ? 'pinned ashore' : caption.bleached ? 'bleaching away' : `strength ${(caption.strength * 100).toFixed(0)}%`}
            {caption.kind ? ` · ${caption.kind}` : ''}
          </em>
          <br />{caption.preview}
        </>)}
      </div>
    </div>
  )
}
