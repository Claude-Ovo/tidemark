-- P0-07 reflection claim, index 2 of 2: given a failure, find the EARLIEST
-- success outcome of the same (agent, task, episode) after it -- stable
-- tiebreak (reported_at, outcome_request_id, attempt_id) is embedded in the
-- key order so the pairing rule reads straight off the index.
CREATE INDEX IF NOT EXISTS outcomes_success_pairing_idx ON public.outcomes (tenant_id, agent_id, task_instance_id, episode_id, status, reported_at, outcome_request_id, attempt_id)
