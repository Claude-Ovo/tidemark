-- P0-07 reflection claim, index 1 of 2 (plan review round-2 item 1): tenant-
-- level bounded scan of failure outcomes by time. The claim query walks this
-- index with a hard LIMIT (reflect_scan_failures=200) -- EXPLAIN-verified in
-- the acceptance suite.
CREATE INDEX IF NOT EXISTS outcomes_failure_scan_idx ON public.outcomes (tenant_id, status, reported_at, agent_id, task_instance_id, episode_id, attempt_id)
