-- /viz/activity remember 源的 keyset 扫描索引（契约 B / SPEC §14）
CREATE INDEX IF NOT EXISTS memories_activity_idx
  ON public.memories (tenant_id, agent_id, created_at, memory_id);
