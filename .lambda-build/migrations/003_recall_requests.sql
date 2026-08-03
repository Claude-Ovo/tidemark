CREATE TABLE IF NOT EXISTS public.recall_requests (
  tenant_id STRING NOT NULL,
  request_id STRING NOT NULL,
  agent_id STRING NOT NULL,
  episode_id STRING,
  attempt_id STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  query_hmac BYTES NOT NULL,
  query_preview STRING,
  pipeline_version STRING NOT NULL,
  outcome_state STRING NOT NULL DEFAULT 'unreported',
  terminal_attempt_id STRING,
  receipt_json JSONB NOT NULL,
  serialization_checksum BYTES NOT NULL,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, request_id),
  CONSTRAINT recall_requests_outcome_state_ck CHECK (outcome_state IN ('unreported', 'reported', 'expired'))
)
