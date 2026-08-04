-- P0-10 round-2 P1-1. memory_rebuild_queue.last_error is an unconstrained STRING. Today's
-- writers only store fixed codes, but a P2 worker or manual repair could echo provider or
-- SQL messages into it, so the auditor surface masks it to a presence flag like the other
-- free-text columns. The base table leaves the audit allowlist in the same delivery.
CREATE VIEW IF NOT EXISTS public.audit_memory_rebuild_queue AS SELECT tenant_id, agent_id, rebuild_id, deleted_derived_memory_id, remaining_source_memory_ids, originating_run_id, status, attempt_count, lease_expires_at, (last_error IS NOT NULL) AS has_last_error, created_at, updated_at, completed_at FROM public.memory_rebuild_queue
