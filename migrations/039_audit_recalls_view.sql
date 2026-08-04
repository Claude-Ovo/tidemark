-- P0-10 Auditor Mode. recall_requests.receipt_json is content-free by frozen invariant. The
-- only column that may carry query text is the debug-only query_preview, masked to a flag.
CREATE VIEW IF NOT EXISTS public.audit_recalls AS SELECT tenant_id, request_id, agent_id, episode_id, attempt_id, created_at, query_hmac, (query_preview IS NOT NULL) AS preview_enabled, pipeline_version, outcome_state, terminal_attempt_id, receipt_json, serialization_checksum, expires_at FROM public.recall_requests
