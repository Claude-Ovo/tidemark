-- Net effect vs 005: adds 'pin', and report_outcome is gone for good -- its
-- idempotency now lives on outcomes (013). 012 stays untouched per the
-- numbered-migrations-are-immutable rule. This supersedes its constraint.
ALTER TABLE public.tool_requests
  DROP CONSTRAINT IF EXISTS tool_requests_tool_name_ck,
  ADD CONSTRAINT tool_requests_tool_name_ck CHECK (tool_name IN ('remember', 'pin', 'log_event'))
