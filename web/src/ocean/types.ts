// /viz API 响应形状（与 src/viz/ocean.mjs 一一对应，服务端是唯一真源）
export type VizMemory = {
  memory_id: string
  layer: 'event' | 'experience'
  kind: string | null
  exp_status: 'candidate' | 'verified' | 'superseded' | null
  pinned: boolean
  state: string
  effective_strength: number   // 服务端在 snapshot_at 时刻实算（契约#2），客户端永不重算
  credited: number
  blamed: number
  created_at: string
  content_preview: string
}

export type VizEpisode = { episode_id: string; memories: VizMemory[] }

export type OceanSnapshot = {
  ok: true
  snapshot_at: string
  fade_threshold: number
  tenant_id: string
  agent_id: string
  agents: { agent_id: string; memory_count: number }[]
  total_memories: number
  capped: boolean          // 快照触顶截断时为 true（保最新，绝不装作全量）
  episodes: VizEpisode[]
  loose: VizMemory[]       // episode_id 为 NULL 的散粒（一审 P1-3：不合成假气泡）
}

export type Wave = {
  request_id: string
  episode_id: string
  attempt_id: string | null
  created_at: string
  items_count: number
}

export type WavesPage = { ok: true; waves: Wave[]; cursor: string | null }
