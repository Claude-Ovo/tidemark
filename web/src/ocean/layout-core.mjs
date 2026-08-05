// 布局纯函数核心（.mjs 而非 .ts：node 测试直接 import，无需编译——determinism 可回归）
// 契约 #1/#4：深度 = 1 - effective_strength 经 easing；一切扰动来自稳定哈希，绝无随机数。

// FNV-1a：同一 id 每次刷新落在同一位置（契约#4——扰动可复现）
export const hash01 = (s, salt = 0) => {
  let h = 0x811c9dc5 ^ salt
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0) / 0xffffffff
}

// 深度 easing：pow(0.72) 把高强度段拉开，让"还记得清楚的"在画面里有层次
export const depthEase = (d) => Math.pow(Math.min(1, Math.max(0, d)), 0.72)

// 世界坐标（0..1 = 整片海，纵向共 DEPTH_SCALE 个视口高——滚动即下潜）
// 分带沿用她的手稿：奶油天空 -> 沙滩(pinned) -> 水体(活着的记忆) -> 海床(白化)
export const WORLD = {
  DEPTH_SCALE: 4.5,
  skyEnd: 0.075,
  beachEnd: 0.13,
  waterEnd: 0.82,
}

// 气泡膜半径：面积随成员数量 sqrt 扩展（一审 P1-6——固定面积无限 overdraw 必然坍塌）
export const bubbleRadius = (n) => Math.min(0.1, 0.016 + 0.011 * Math.sqrt(n))

// 密度 LOD：每条记忆的 splat 数随气泡拥挤度降档（确定性，无随机）
export const splatsPerMemory = (n) => (n <= 12 ? 6 : n <= 24 ? 4 : 3)

// 命中检测（纯函数，二审 Block 项）：相机参数必须是【实际绘制那一帧用的相机】——
// 快速滚动时平滑相机落后目标数屏，用目标相机命中会选中根本不在屏上的记忆。
// hover/点击/透镜一律复用此函数，绝不各自再写一份坐标数学。
export const hitTestOcean = (placed, mxCss, myCss, rectW, rectH, paintedCam, radiusCss = 26) => {
  const worldH = rectH * WORLD.DEPTH_SCALE
  const camOff = paintedCam * (worldH - rectH)
  let best = null, bestD = radiusCss * radiusCss
  for (const ep of placed) {
    for (const p of ep.memories) {
      const dx = p.x * rectW - mxCss
      const dy = p.y * worldH - camOff - myCss
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = { episode: ep, placed: p } }
    }
  }
  return best
}
