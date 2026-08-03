-- P0-07 code review item 6 (tail): run provenance was unenforced -- a ledger
-- row could reference a nonexistent run. Same FK discipline as
-- memory_derivations/memory_event_evidence.
ALTER TABLE public.reflection_pairs ADD CONSTRAINT IF NOT EXISTS rp_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.nightly_runs (tenant_id, run_id)
