-- Attempt ownership fix (Codex P0-05 second review, item 2): terminal
-- uniqueness is per (tenant, agent, attempt), not tenant-global -- an attempt
-- is an agent-private concept, and tenant-global uniqueness let any same-
-- tenant agent squat another agent's terminal slot with an empty cancelled.
-- Created BEFORE 019 drops the old index so a uniqueness guard exists at
-- every point of the upgrade.
CREATE UNIQUE INDEX IF NOT EXISTS outcomes_agent_attempt_uq ON public.outcomes (tenant_id, agent_id, attempt_id)
