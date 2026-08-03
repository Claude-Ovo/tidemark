CREATE TABLE IF NOT EXISTS public.memory_event_evidence (
  tenant_id STRING NOT NULL,
  derived_memory_id UUID NOT NULL,
  attempt_id STRING NOT NULL,
  event_id UUID NOT NULL,
  run_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, derived_memory_id, attempt_id, event_id),
  CONSTRAINT memory_event_evidence_memory_fk FOREIGN KEY (tenant_id, derived_memory_id) REFERENCES public.memories (tenant_id, memory_id) ON DELETE CASCADE,
  CONSTRAINT memory_event_evidence_event_fk FOREIGN KEY (tenant_id, attempt_id, event_id) REFERENCES public.attempt_events (tenant_id, attempt_id, event_id),
  CONSTRAINT memory_event_evidence_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.nightly_runs (tenant_id, run_id)
)
