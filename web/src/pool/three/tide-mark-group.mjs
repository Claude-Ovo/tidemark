import { polarToWorld } from './config.mjs'

// Outcome marks are shader-local sediment/glints, not geometry. Keeping this
// projection pure makes the result-gated lifetime directly testable and keeps
// all circular topology invisible.
export const selectShaderTideMarks = (rings, limit) => (Array.isArray(rings) ? rings : [])
  .slice()
  .sort((a, b) => Number(b.t0) - Number(a.t0))
  .slice(0, Math.max(0, Number(limit) || 0))
  .map((ring) => {
    const point = polarToWorld(ring.p)
    return {
      x: point.x,
      z: point.z,
      born: Number(ring.t0) / 1000,
      polarity: ring.kind === 'credited' ? 1 : -1,
      memory_id: ring.p?.memory_id ?? null,
    }
  })
