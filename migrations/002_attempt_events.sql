CREATE TABLE IF NOT EXISTS public.attempt_events (
  tenant_id STRING NOT NULL,
  agent_id STRING NOT NULL,
  episode_id STRING NOT NULL,
  task_instance_id STRING NOT NULL,
  attempt_id STRING NOT NULL,
  event_id UUID NOT NULL DEFAULT gen_random_uuid(),
  event_type STRING NOT NULL,
  tool_name STRING,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, attempt_id, event_id),
  CONSTRAINT attempt_events_event_type_ck CHECK (event_type IN ('tool_call', 'tool_error', 'user_correction', 'attempt_start', 'attempt_end', 'memory_used', 'note')),
  INDEX ae_task_idx (tenant_id, task_instance_id, created_at)
)
