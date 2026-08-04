-- P0-10 Auditor Mode. source_snapshot/result_receipt/control_config are content-free by
-- design. error_message is free-form operational text and could echo provider output, so it
-- is masked to a flag while error_code stays queryable.
CREATE VIEW IF NOT EXISTS public.audit_nightly_runs AS SELECT tenant_id, run_id, job_kind, scheduled_for, pipeline_version, status, lease_expires_at, attempt_count, batch_size, source_snapshot, source_fingerprint, model_id, error_code, (error_message IS NOT NULL) AS has_error_message, started_at, completed_at, updated_at, control_config, result_receipt FROM public.nightly_runs
