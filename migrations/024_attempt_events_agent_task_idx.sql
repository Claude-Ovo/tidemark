-- P0-07 reflection pairing (plan review round-2 item 2 of first review, agent
-- scope): event context lookups and pair evidence collection go through
-- (tenant, agent, task) -- ae_task_idx lacks the agent prefix, so same-tenant
-- agents reusing task strings would scan each other's rows.
CREATE INDEX IF NOT EXISTS ae_agent_task_idx ON public.attempt_events (tenant_id, agent_id, task_instance_id, created_at)
