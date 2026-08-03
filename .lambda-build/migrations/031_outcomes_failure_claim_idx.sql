-- P0-07 code review item 3: the bounded failure claim needs an index whose
-- key order IS the claim's stable ORDER BY (tenant, status, reported_at,
-- outcome_request_id) so the LIMIT-200 CTE is physically bounded. 025 keeps
-- serving agent/task-dimension audit lookups.
CREATE INDEX IF NOT EXISTS outcomes_failure_claim_idx ON public.outcomes (tenant_id, status, reported_at, outcome_request_id)
