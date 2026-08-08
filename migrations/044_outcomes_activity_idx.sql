-- /viz/activity outcome 源的 keyset 扫描索引（契约 B / SPEC §14）；recall 源复用 042
CREATE INDEX IF NOT EXISTS outcomes_activity_idx
  ON public.outcomes (tenant_id, agent_id, reported_at, outcome_request_id);
