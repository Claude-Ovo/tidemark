-- SPEC 1.5 semantic ownership: report_outcome idempotency lives on its own
-- table, not in tool_requests. outcomes PK (tenant_id, outcome_request_id)
-- is already the idempotency key. These columns carry the keyed payload
-- fingerprint and the exact first response for replay.
ALTER TABLE public.outcomes
  ADD COLUMN IF NOT EXISTS payload_hmac BYTES,
  ADD COLUMN IF NOT EXISTS response_json JSONB
