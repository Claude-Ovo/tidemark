// 迁移/生长/入场的运动状态机（纯逻辑、零 DOM，node 可测——动效批一审 P1-1）。
// 核心不变量：任何会改变粒子 painted anchor 的路径（tween 逐帧/完成帧、REDUCED 直落、
// 快照 theta-only relayout）都必须把粒子标进【持久 dirty 集】，由消费方（draw→placeBtn）
// 显式 consumeDirty() 后才清——脏标记跨 step→draw 存活，不随 tween 数组的删除而丢失。
// Codex 三反例的结构性封堵：
//   ① 后台 tab 恢复单帧跨过整段 dur：完成帧仍标 dirty（标记发生在 step 迭代内，先于过滤）
//   ② 运行时切 reduced：reduceFlush 把在途 tween 的粒子全部标 dirty 再清数组
//   ③ 快照只改 theta 不改 r：thetaUpdate 显式标 dirty（不依赖 tween 存在）

export const MOTION = {
  MIGRATE_MS: 1500,           // 迁移 settle（结论 65：可中断，从当前呈现值 retarget）
  RIPPLE_MS: 1400,            // 涟漪扩散
  RAIN_FALL_MS: 380,          // remember 雨滴下落（落体 ease-in = 重力）
  ATTACH_GROW_MS: 220,        // 着水后粒子从滴径长到 markR
  ENTRANCE_MS: 260,           // 首屏单粒子淡入
  ENTRANCE_LAYER_MS: 180,     // 首屏层间错峰（anchor→active→receding）
  ENTRANCE_SWEEP_MS: 260,     // 首屏层内按角向扫过
  HOVER_INTENT_MS: 150, HOVER_WARM_MS: 400,
  RING_STAY: 4500, RING_FADE: 800,   // 潮痕停留/淡出（四审 P1-3 签定值）
}

// 精确 cubic-bezier 求值（牛顿迭代+二分兜底）——AUDIT 指定曲线逐字落，不用弱内建近似
export const cubicBezier = (p1x, p1y, p2x, p2y) => {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by
  const sx = (t) => ((ax * t + bx) * t + cx) * t
  const sy = (t) => ((ay * t + by) * t + cy) * t
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x
      if (Math.abs(err) < 1e-6) return sy(t)
      const d = dx(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    let lo = 0, hi = 1
    while (hi - lo > 1e-6) { t = (lo + hi) / 2; if (sx(t) < x) lo = t; else hi = t }
    return sy(t)
  }
}
export const easeInOutStrong = cubicBezier(0.77, 0, 0.175, 1)   // 迁移：屏上位移用强 in-out
export const easeOutStrong = cubicBezier(0.23, 1, 0.32, 1)      // 涟漪扩张/生长/入场：强 ease-out
export const easeInQuad = (k) => k * k                          // 雨滴落体（物理：匀加速）

export const makeMotionState = () => {
  let tweens = []       // { p, from, to, t0, dur }（可中断：新 tween 从当前 pr 起算并顶掉旧的）
  let grows = []        // { p, t0 }（着水后 markR 生长）
  let entrances = []    // { p, t0 }（首屏一次性错峰入场；t0 可为未来=延迟）
  const dirty = new Set()   // 持久：只被 consumeDirty 清空

  return {
    // 迁移：REDUCED 直落终态也必须标 dirty（按钮要跟着跳）
    migrate(p, to, { dur = MOTION.MIGRATE_MS, reduced = false, now }) {
      if (reduced) { p.pr = to; dirty.add(p); return }
      tweens = tweens.filter(t => t.p !== p)          // 中断旧 tween：from 取当前 pr，不回跳
      tweens.push({ p, from: p.pr, to, t0: now, dur })
    },
    grow(p, now) { p.mrScale = 0.45; grows.push({ p, t0: now }) },
    enter(p, t0) { p.alpha = 0; entrances.push({ p, t0 }) },
    // 快照 relayout：theta 变了就标 dirty——不依赖有没有半径 tween（Codex 反例③）
    thetaUpdate(p, theta) {
      if (p.theta !== theta) { p.theta = theta; dirty.add(p) }
    },
    // 运行时切 reduced：在途 tween 直落终态并标 dirty（Codex 反例②）；生长/入场直落
    reduceFlush() {
      for (const tw of tweens) { tw.p.pr = tw.to; dirty.add(tw.p) }
      tweens = []
      for (const g of grows) g.p.mrScale = 1
      grows = []
      for (const en of entrances) en.p.alpha = 1
      entrances = []
    },
    // 逐帧推进：迭代内标 dirty（先标后滤——单帧跨过整段 dur 的完成帧也有标记，Codex 反例①）
    step(now) {
      for (const tw of tweens) {
        const k = Math.min(1, (now - tw.t0) / tw.dur)
        tw.p.pr = tw.from + (tw.to - tw.from) * easeInOutStrong(k)
        dirty.add(tw.p)
      }
      tweens = tweens.filter(tw => now - tw.t0 < tw.dur)
      for (const g of grows) {
        const k = Math.min(1, (now - g.t0) / MOTION.ATTACH_GROW_MS)
        g.p.mrScale = 0.45 + 0.55 * easeOutStrong(k)
      }
      grows = grows.filter(g => { if (now - g.t0 < MOTION.ATTACH_GROW_MS) return true; g.p.mrScale = 1; return false })
      for (const en of entrances) {
        const k = Math.min(1, Math.max(0, (now - en.t0) / MOTION.ENTRANCE_MS))
        en.p.alpha = easeOutStrong(k)
      }
      entrances = entrances.filter(en => { if (now - en.t0 < MOTION.ENTRANCE_MS) return true; en.p.alpha = 1; return false })
    },
    active() { return tweens.length > 0 || grows.length > 0 || entrances.length > 0 },
    tweening() { return tweens.length > 0 },
    // 消费即清：draw 帧末拿走本帧需要重放位置的粒子集合
    consumeDirty() {
      if (!dirty.size) return []
      const out = [...dirty]
      dirty.clear()
      return out
    },
    _debug() { return { tweens: tweens.length, grows: grows.length, entrances: entrances.length, dirty: dirty.size } },
  }
}
