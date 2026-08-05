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
import { hash01, WORLD, splatsPerMemory, hitTestOcean } from './layout-core.mjs'
import { SKY, CLOUD, SAND, WATER, SEABED, CORAL_BLEACHED, CORAL_GLOW, FISH, GOLD_DUST, FOAM, memoryColor, pearlColor } from './palette'

export type FoamWave = { request_id: string; episode_id: string | null; arrivedAt: number }
export type OpenTarget = { m: import('./types').VizMemory; episode_id: string | null; sx: number; sy: number; bleached: boolean
  animateEntrance: boolean }
type Caption = { pinned: boolean; bleached: boolean; kind: string | null; strength: number; preview: string }
type Props = {
  snap: OceanSnapshot; waves: FoamWave[]; cameraRef: RefObject<number>
  onOpen: (t: OpenTarget) => void        // 点击命中一颗记忆 -> 交给透镜（同一 hitTestOcean）
  highlightId: string | null             // 键盘巡航聚焦的记忆（视觉高亮与 hover 同款）
}

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

// 世界级背景一次性铺陈（resize 才重画）：整片海 4.5 屏高的 offscreen，逐帧按相机裁剪位块。
// v2 美术基准 = 她的 GPT 全景参考图（ovo.jpg）降饱和 30%：蓝天白云、斜向沙水线、
// 丁达尔光柱、鱼群洋流与漩涡（鱼群参考图）、金色光尘（银河鱼群参考图）、水母、紫晕白珊瑚。
const fishSplat = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number,
  ang: number, alpha: number) => {
  splat(ctx, x, y, size, size * 0.42, ang, FISH, alpha)
  splat(ctx, x - Math.cos(ang) * size * 1.15, y - Math.sin(ang) * size * 0.5,
    size * 0.42, size * 0.3, ang + 0.55, FISH, alpha * 0.85)
}

const paintBackdrop = (c: HTMLCanvasElement, W: number, WORLD_H: number) => {
  const ctx = c.getContext('2d')!
  const lg = ctx.createLinearGradient(0, 0, 0, WORLD_H)
  lg.addColorStop(0, SKY[0]); lg.addColorStop(WORLD.skyEnd, SKY[1])
  lg.addColorStop(WORLD.skyEnd + 0.004, SAND[0]); lg.addColorStop(WORLD.beachEnd, SAND[1])
  lg.addColorStop(WORLD.beachEnd + 0.004, WATER[0]); lg.addColorStop(0.3, WATER[1])
  lg.addColorStop(0.48, WATER[2]); lg.addColorStop(0.66, WATER[3])
  lg.addColorStop(WORLD.waterEnd, WATER[4]); lg.addColorStop(1, SEABED)
  ctx.fillStyle = lg; ctx.fillRect(0, 0, W, WORLD_H)

  // 斜向沙水线（参考图的有机水线，不做水平硬线）：沙滩下缘随 x 缓变，边缘铺泡沫
  const edgeY = (x01: number) => WORLD.beachEnd + 0.012 * (x01 - 0.5) - 0.004 * Math.sin(x01 * 6.3)
  ctx.save(); ctx.beginPath(); ctx.moveTo(0, WORLD.skyEnd * WORLD_H)
  for (let i = 0; i <= 40; i++) ctx.lineTo((i / 40) * W, edgeY(i / 40) * WORLD_H)
  ctx.lineTo(W, WORLD.skyEnd * WORLD_H); ctx.closePath()
  const sg = ctx.createLinearGradient(0, WORLD.skyEnd * WORLD_H, 0, (WORLD.beachEnd + 0.012) * WORLD_H)
  sg.addColorStop(0, SAND[0]); sg.addColorStop(1, SAND[1])
  ctx.fillStyle = sg; ctx.fill(); ctx.restore()
  for (let i = 0; i < 34; i++) {
    const x01 = hash01(`fm${i}`, 57)
    splat(ctx, x01 * W, (edgeY(x01) + (hash01(`fm${i}`, 58) - 0.5) * 0.003) * WORLD_H,
      0.045 * W, 0.0011 * WORLD_H, (hash01(`fm${i}`, 60) - 0.5) * 0.15, FOAM, 0.2, true)
  }

  // 印象派大色粒（各带同色系微差）
  const bandColor = (v: number): string =>
    v < WORLD.skyEnd ? SKY[1] : v < WORLD.beachEnd ? SAND[Math.floor(hash01(String(v), 2) * 2)]
    : v < 0.3 ? WATER[0] : v < 0.48 ? WATER[1] : v < 0.66 ? WATER[2] : v < WORLD.waterEnd ? WATER[3] : WATER[4]
  for (let i = 0; i < 780; i++) {
    const y = hash01(`bg${i}`, 31)
    splat(ctx, hash01(`bg${i}`, 37) * W, y * WORLD_H, (0.04 + hash01(`bg${i}`, 41) * 0.09) * W,
      (0.01 + hash01(`bg${i}`, 43) * 0.022) * WORLD_H, (hash01(`bg${i}`, 47) - 0.5) * 0.9,
      bandColor(y), 0.05 + hash01(`bg${i}`, 53) * 0.08)
  }

  // 蓝天白云 + 天光 bloom（参考图的云）
  for (const [cx0, cy0, sc] of [[0.32, 0.022, 1], [0.62, 0.014, 0.7], [0.8, 0.03, 0.55]] as const) {
    for (let i = 0; i < 7; i++) {
      splat(ctx, (cx0 + (hash01(`cl${cx0}${i}`, 91) - 0.5) * 0.1) * W,
        (cy0 + (hash01(`cl${cx0}${i}`, 93) - 0.5) * 0.006) * WORLD_H,
        (0.045 + hash01(`cl${cx0}${i}`, 95) * 0.03) * W * sc, 0.008 * WORLD_H * sc,
        (hash01(`cl${cx0}${i}`, 97) - 0.5) * 0.3, CLOUD, 0.5)
    }
  }
  splat(ctx, W * 0.5, WORLD_H * 0.008, W * 0.26, WORLD_H * 0.016, 0, '#fff8e6', 0.42, true)

  // 丁达尔光柱：宽软斜光束（首版分段旋转叠成了麻花，实拍打回——改单角度大椭圆低透明重叠）
  for (let r = 0; r < 5; r++) {
    const rx = 0.16 + r * 0.16 + hash01(`ray${r}`, 141) * 0.05
    const topY = WORLD.beachEnd + 0.01, len = 0.18 + hash01(`ray${r}`, 143) * 0.08
    for (let seg = 0; seg < 4; seg++) {
      const t = seg / 4
      splat(ctx, (rx + t * 0.05) * W, (topY + (t + 0.12) * len) * WORLD_H,
        (0.034 - t * 0.01) * W, len * WORLD_H * 0.34, 0.1,
        '#e6f3f6', (1 - t) * 0.038, true)
    }
  }

  // 鱼群洋流三条 + 漩涡一枚（鱼群参考图：曲线带状、越深越暗）
  const bez = (p0: number[], p1: number[], p2: number[], t: number) => [
    (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
    (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
  ]
  const bands: Array<{ p: number[][]; n: number; s: number; a: number; flip?: boolean }> = [
    { p: [[0.02, 0.335], [0.45, 0.415], [0.9, 0.35]], n: 110, s: 1.0, a: 0.6 },
    { p: [[0.96, 0.5], [0.55, 0.585], [0.06, 0.53]], n: 88, s: 0.9, a: 0.5, flip: true },
    { p: [[0.04, 0.665], [0.5, 0.71], [0.94, 0.655]], n: 66, s: 0.8, a: 0.38 },
  ]
  for (let bi = 0; bi < bands.length; bi++) {
    const b = bands[bi]
    for (let i = 0; i < b.n; i++) {
      const t = hash01(`f${bi}-${i}`, 151)
      const [px, py] = bez(b.p[0], b.p[1], b.p[2], t)
      const [qx, qy] = bez(b.p[0], b.p[1], b.p[2], Math.min(1, t + 0.02))
      const ang = Math.atan2((qy - py) * WORLD_H, (qx - px) * W) + (b.flip ? Math.PI : 0)
      const jx = (hash01(`f${bi}-${i}`, 153) - 0.5) * 0.05
      const jy = (hash01(`f${bi}-${i}`, 155) - 0.5) * 0.018
      fishSplat(ctx, (px + jx) * W, (py + jy) * WORLD_H,
        (0.0035 + hash01(`f${bi}-${i}`, 157) * 0.003) * W * b.s, ang,
        b.a * (0.6 + hash01(`f${bi}-${i}`, 159) * 0.4))
    }
  }
  for (let i = 0; i < 38; i++) {   // 漩涡（她的鱼群旋涡参考图）：绕亮心一圈
    const a = hash01(`v${i}`, 161) * Math.PI * 2
    const rr = 0.032 + hash01(`v${i}`, 163) * 0.02
    fishSplat(ctx, (0.74 + Math.cos(a) * rr * 1.15) * W, (0.455 + Math.sin(a) * rr * 0.5) * WORLD_H,
      (0.003 + hash01(`v${i}`, 165) * 0.002) * W, a + Math.PI / 2, 0.5)
  }
  splat(ctx, 0.74 * W, 0.455 * WORLD_H, 0.03 * W, 0.014 * WORLD_H, 0, '#cfe8ec', 0.16, true)

  // 光衰：越深越暗（先压暗——荧光/金尘/珊瑚必须画在黑暗之上才透得出来）
  const dk = ctx.createLinearGradient(0, WORLD_H * 0.5, 0, WORLD_H)
  dk.addColorStop(0, 'rgba(4,10,24,0)'); dk.addColorStop(1, 'rgba(6,10,28,0.52)')
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = dk; ctx.fillRect(0, WORLD_H * 0.5, W, WORLD_H * 0.5)

  // 金色光尘（银河鱼群参考图）+ 生物荧光 + 海雪
  for (let i = 0; i < 60; i++) {
    const y = 0.42 + hash01(`gd${i}`, 171) * 0.5
    splat(ctx, hash01(`gd${i}`, 173) * W, y * WORLD_H, 0.0022 * W, 0.0016 * W,
      0, GOLD_DUST, 0.1 + hash01(`gd${i}`, 175) * 0.12, true)
  }
  for (let i = 0; i < 46; i++) {
    const y = 0.5 + hash01(`gl${i}`, 107) * 0.3
    splat(ctx, hash01(`gl${i}`, 109) * W, y * WORLD_H, 0.004 * W, 0.003 * W,
      0, i % 3 ? '#7fd4d4' : '#b7e6c9', 0.18, true)
  }
  for (let i = 0; i < 30; i++) {
    const y = 0.42 + hash01(`sn${i}`, 111) * 0.52
    splat(ctx, hash01(`sn${i}`, 113) * W, y * WORLD_H, 0.0016 * W, 0.0012 * W, 0, '#e8f2f2', 0.09, true)
  }

  // 装饰玻璃泡（参考图的透明环泡，与数据气泡区分：环形描边+高光弧）
  for (let i = 0; i < 7; i++) {
    const bx = hash01(`db${i}`, 181) * 0.9 + 0.05, by = 0.4 + hash01(`db${i}`, 183) * 0.5
    const br = (0.008 + hash01(`db${i}`, 185) * 0.01) * W
    ctx.save(); ctx.globalAlpha = 0.35; ctx.strokeStyle = 'rgba(235,248,250,0.7)'
    ctx.lineWidth = Math.max(1, br * 0.09)
    ctx.beginPath(); ctx.arc(bx * W, by * WORLD_H, br, 0, Math.PI * 2); ctx.stroke()
    ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(1, br * 0.14)
    ctx.beginPath(); ctx.arc(bx * W, by * WORLD_H, br * 0.82, -2.3, -1.1); ctx.stroke(); ctx.restore()
  }

  // 水母两只（参考图深水的发光体）：铃体 + 垂须（首版太弱像色斑，实拍打回加大加亮）
  for (const [jx, jy, js] of [[0.17, 0.76, 1], [0.83, 0.71, 0.8]] as const) {
    const R = 0.024 * W * js
    splat(ctx, jx * W, jy * WORLD_H, R * 3, R * 2.4, 0, '#b9a8d6', 0.22, true)
    splat(ctx, jx * W, jy * WORLD_H, R, R * 0.7, 0, '#eee4f6', 0.75)
    splat(ctx, jx * W, jy * WORLD_H + R * 0.28, R * 0.85, R * 0.4, 0, '#c9b6e2', 0.4)
    splat(ctx, jx * W - R * 0.25, jy * WORLD_H - R * 0.3, R * 0.5, R * 0.32, -0.3, '#fbf8fe', 0.85, true)
    for (let tt = 0; tt < 6; tt++) {
      for (let seg = 1; seg <= 11; seg++) {
        splat(ctx, (jx + (tt - 2.5) * 0.0045 + Math.sin(seg * 0.9 + tt * 1.7) * 0.0026) * W,
          jy * WORLD_H + R * 0.55 + seg * R * 0.42,
          R * 0.08, R * 0.2, 0.2, '#d8cbee', 0.42 - seg * 0.033, true)
      }
    }
  }

  // 白化珊瑚海床：紫晕背光（参考图）+ 真分枝（扇形角 x 沿枝串珠——首版把枝索引和
  // 沿枝距离混成一个变量，每枝只剩一颗珠，实拍成了蠕虫柱，打回重构）。
  // 纵向伸展一律 W 基准锁纵横比（WORLD_H 基准会随视口变高拉成蜡烛）。
  for (let k = 0; k < 8; k++) {
    const bx = (0.06 + k * 0.12 + hash01(`c${k}`, 59) * 0.05) * W
    const by = WORLD_H * 0.99 - hash01(`c${k}`, 61) * 0.008 * W
    splat(ctx, bx, by - 0.024 * W, 0.062 * W, 0.03 * W, 0, CORAL_GLOW, 0.16, true)
    const branches = 6 + Math.floor(hash01(`c${k}`, 63) * 3)
    for (let br = 0; br < branches; br++) {
      // 扇形保底展开 + 哈希微抖；枝长各异；沿枝微曲
      const ang = -Math.PI / 2 + ((br / (branches - 1)) - 0.5) * 2.1
        + (hash01(`c${k}r${br}`, 67) - 0.5) * 0.3
      const len = (0.028 + hash01(`c${k}r${br}`, 69) * 0.03) * W
      const bend = (hash01(`c${k}r${br}`, 73) - 0.5) * 1.2
      for (let seg = 0; seg <= 6; seg++) {
        const t = seg / 6
        const a2 = ang + bend * t * 0.5
        splat(ctx, bx + Math.cos(a2) * t * len, by + Math.sin(a2) * t * len,
          0.0075 * W * (1 - t * 0.55), 0.006 * W * (1 - t * 0.55),
          a2, CORAL_BLEACHED, 0.72 - t * 0.26)
      }
    }
  }

  // 棕榈：树冠探进画面（参考图构图），干弯向画心
  for (const [tx, flip] of [[0.05, 1], [0.94, -1]] as const) {
    const px = tx * W, py = WORLD_H * (WORLD.skyEnd - 0.004)
    for (let seg = 0; seg < 5; seg++) {
      splat(ctx, px + flip * seg * 0.008 * W, py - seg * 0.0035 * WORLD_H,
        0.006 * W, 0.004 * WORLD_H, flip * 0.5, '#6d5138', 0.6)
    }
    const cx0 = px + flip * 0.04 * W, cy0 = py - 0.018 * WORLD_H
    for (let f = 0; f < 9; f++) {
      const ang = -Math.PI * 0.9 + f * 0.42
      splat(ctx, cx0 + Math.cos(ang) * 0.035 * W, cy0 + Math.sin(ang) * 0.007 * WORLD_H,
        0.032 * W, 0.007 * W, ang * 0.35 * flip, f % 2 ? '#527a4e' : '#6a9861', 0.55)
    }
  }
}

export const OceanCanvas = ({ snap, waves, cameraRef, onOpen, highlightId }: Props) => {
  const cvsRef = useRef<HTMLCanvasElement>(null)
  const capRef = useRef<HTMLDivElement>(null)
  const placedRef = useRef<PlacedEpisode[]>([])
  const snapDirtyRef = useRef(true)
  const wavesRef = useRef<FoamWave[]>([])
  const hoverIdRef = useRef<string | null>(null)
  // 实际绘制那一帧的相机（二审 Block 项：hit-test 只许读它，绝不读目标相机——
  // 快速滚动中两者可差数屏，用目标相机会命中不在屏上的记忆）
  const paintedCamRef = useRef(0)
  const [caption, setCaption] = useState<Caption | null>(null)

  // 数据经 ref 进入渲染循环（动效A：绝不作为 effect 依赖重建循环）
  useEffect(() => { placedRef.current = layoutOcean(snap); snapDirtyRef.current = true }, [snap])
  useEffect(() => { wavesRef.current = waves; snapDirtyRef.current = true }, [waves])
  const highlightRef = useRef<string | null>(null)
  useEffect(() => { highlightRef.current = highlightId; snapDirtyRef.current = true }, [highlightId])

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
      paintedCamRef.current = cam

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
        // 玻璃环膜（参考图的透明泡质感）：宽淡外圈 + 内侧高光弧 + 顶部反光点
        ctx.save()
        ctx.globalAlpha = 0.2; ctx.strokeStyle = 'rgba(230,248,250,0.85)'
        ctx.lineWidth = Math.max(1, cr * 0.06)
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 0.38; ctx.lineWidth = Math.max(1, cr * 0.05)
        ctx.beginPath(); ctx.arc(cx, cy, cr * 0.9, -2.3, -1.0); ctx.stroke()
        ctx.globalAlpha = 0.22; ctx.lineWidth = Math.max(1, cr * 0.03)
        ctx.beginPath(); ctx.arc(cx, cy, cr * 0.93, 0.6, 1.5); ctx.stroke()
        ctx.restore()
        splat(ctx, cx - cr * 0.5, cy - cr * 0.62, cr * 0.14, cr * 0.09, -0.6, '#f6fcff', 0.5, true)
      }
      for (const ep of placedRef.current) {
        const lod = splatsPerMemory(ep.memories.length)   // 一审 P1-6：密度降档
        for (const p of ep.memories) {
          const amp = p.m.pinned ? 0 : p.bleached ? 0.001 : 0.003   // 岸上不漂，海床微动
          const x = p.x * W, y = sy(p.y, bob(p.m.memory_id, amp))
          if (!onScreen(y)) continue
          const base = (p.m.layer === 'experience' ? 9 : 7) * p.r * (W / 1400)
          const hovered = hoverIdRef.current === p.m.memory_id || highlightRef.current === p.m.memory_id
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
    const found = hitTestOcean(placedRef.current, mx, my, rect.width, rect.height, paintedCamRef.current)
    const p = found?.placed
    const hit: { id: string; c: Caption } | null = p
      ? { id: p.m.memory_id, c: { pinned: p.m.pinned, bleached: p.bleached,
          kind: p.m.kind, strength: p.m.effective_strength, preview: p.m.content_preview } }
      : null
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

  // 点击开透镜：与 hover 同一 hitTestOcean、同一 painted 相机——坐标真相只有一份。
  // 四审 P1：开泡瞬间清干净 hover 字幕与高亮——半透明泡体挡不住底下的残字；
  // 泡开着时透镜 overlay 覆盖全屏，pointermove 到不了画布，不会被重新点亮。
  const onClick = (e: React.MouseEvent) => {
    const rect = cvsRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const found = hitTestOcean(placedRef.current, mx, my, rect.width, rect.height, paintedCamRef.current)
    if (found) {
      hoverIdRef.current = null
      snapDirtyRef.current = true
      setCaption(null)
      if (capRef.current) capRef.current.style.opacity = '0'
      onOpen({ m: found.placed.m, episode_id: found.episode.episode_id,
        sx: e.clientX, sy: e.clientY, bleached: found.placed.bleached, animateEntrance: true })
    }
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}
      onPointerMove={onMove}
      onClick={onClick}
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
