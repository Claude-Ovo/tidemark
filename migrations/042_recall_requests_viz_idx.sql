-- P0-11 review round 1 P1-5. The waves endpoint pages recall receipts with a keyset
-- cursor: WHERE (tenant_id, agent_id) fixed AND (created_at, request_id) > cursor
-- ORDER BY created_at, request_id. The primary key (tenant_id, request_id) cannot
-- serve that shape. Without this index every 8-second poll is a per-agent scan.
CREATE INDEX IF NOT EXISTS recall_requests_viz_idx
  ON public.recall_requests (tenant_id, agent_id, created_at, request_id)
