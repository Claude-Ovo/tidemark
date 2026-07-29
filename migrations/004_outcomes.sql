CREATE TABLE IF NOT EXISTS public.outcomes (
  tenant_id STRING NOT NULL,
  outcome_request_id STRING NOT NULL,
  agent_id STRING NOT NULL,
  episode_id STRING NOT NULL,
  task_instance_id STRING NOT NULL,
  attempt_id STRING NOT NULL,
  status STRING NOT NULL,
  attributions JSONB NOT NULL,
  plasticity_applied BOOL NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outcome_request_id),
  UNIQUE INDEX outcomes_attempt_uq (tenant_id, attempt_id),
  CONSTRAINT outcomes_status_ck CHECK (status IN ('success', 'failure', 'cancelled'))
)
