-- Data repositioning, prerequisite for 015's tightened CHECK: report_outcome
-- rows in tool_requests were a semantic-ownership violation (SPEC 1.5) -- the
-- outcomes table is the source of truth for every settled outcome, so these
-- rows are redundant claim copies, not unique data. Idempotent (re-run deletes
-- zero rows).
DELETE FROM public.tool_requests WHERE tool_name = 'report_outcome'
