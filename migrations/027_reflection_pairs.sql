-- P0-07 exactly-once ledger for reflection (plan review item 5 + round-2 item 2):
-- attempt_events/outcomes never change state, so consumed failure->success
-- pairs are recorded here and claims anti-join via NOT EXISTS. Attempt IDs
-- form the exactly-once key. Terminal truth is anchored to outcomes by FK
-- (never a fabricated attempt_end event). experience_id may point to a
-- deduped winner rather than a fresh row. Conclusion 38 pattern: no agent_id
-- in FK targets -- memories_tenant_memory_uq / outcomes PK carry tenant scope,
-- service layer guards agent scope.
CREATE TABLE IF NOT EXISTS public.reflection_pairs (
  tenant_id STRING NOT NULL,
  agent_id STRING NOT NULL,
  failure_attempt_id STRING NOT NULL,
  success_attempt_id STRING NOT NULL,
  failure_outcome_request_id STRING NOT NULL,
  success_outcome_request_id STRING NOT NULL,
  pair_fingerprint BYTES NOT NULL,
  experience_id UUID NOT NULL,
  run_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, failure_attempt_id, success_attempt_id),
  CONSTRAINT rp_failure_outcome_fk FOREIGN KEY (tenant_id, failure_outcome_request_id) REFERENCES public.outcomes (tenant_id, outcome_request_id),
  CONSTRAINT rp_success_outcome_fk FOREIGN KEY (tenant_id, success_outcome_request_id) REFERENCES public.outcomes (tenant_id, outcome_request_id),
  CONSTRAINT rp_experience_fk FOREIGN KEY (tenant_id, experience_id) REFERENCES public.memories (tenant_id, memory_id)
)
