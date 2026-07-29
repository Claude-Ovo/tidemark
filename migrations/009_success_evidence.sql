CREATE TABLE IF NOT EXISTS public.success_evidence (
  tenant_id STRING NOT NULL,
  experience_id UUID NOT NULL,
  task_instance_id STRING NOT NULL,
  outcome_request_id STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, experience_id, task_instance_id),
  CONSTRAINT success_evidence_memory_fk FOREIGN KEY (tenant_id, experience_id) REFERENCES public.memories (tenant_id, memory_id) ON DELETE CASCADE,
  CONSTRAINT success_evidence_outcome_fk FOREIGN KEY (tenant_id, outcome_request_id) REFERENCES public.outcomes (tenant_id, outcome_request_id)
)
