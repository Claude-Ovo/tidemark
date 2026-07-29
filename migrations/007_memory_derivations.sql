CREATE TABLE IF NOT EXISTS public.memory_derivations (
  tenant_id STRING NOT NULL,
  derived_memory_id UUID NOT NULL,
  source_memory_id UUID NOT NULL,
  run_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, derived_memory_id, source_memory_id),
  CONSTRAINT memory_derivations_no_self_ck CHECK (derived_memory_id <> source_memory_id),
  CONSTRAINT memory_derivations_derived_fk FOREIGN KEY (tenant_id, derived_memory_id) REFERENCES public.memories (tenant_id, memory_id) ON DELETE CASCADE,
  CONSTRAINT memory_derivations_source_fk FOREIGN KEY (tenant_id, source_memory_id) REFERENCES public.memories (tenant_id, memory_id),
  CONSTRAINT memory_derivations_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.nightly_runs (tenant_id, run_id)
)
