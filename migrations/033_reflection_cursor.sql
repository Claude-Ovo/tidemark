-- P0-07 round-3 item 1: durable keyset cursor for the reflection failure scan.
-- The scan starts strictly after (last_reported_at, last_outcome_request_id)
-- and the cursor only ever advances past TERMINATED prefix rows (paired this
-- night, or expired: no success within the 72h window and the window has
-- closed). Rows still waiting inside their window block the cursor -- that is
-- correct semantics, and the service capacity SLA (documented in SPEC 6) is
-- that unpaired in-window failures per tenant stay under the scan bound.
CREATE TABLE IF NOT EXISTS public.reflection_cursor (
  tenant_id STRING NOT NULL,
  last_reported_at TIMESTAMPTZ NOT NULL,
  last_outcome_request_id STRING NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
)
