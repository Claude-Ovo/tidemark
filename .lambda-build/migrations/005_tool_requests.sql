CREATE TABLE IF NOT EXISTS public.tool_requests (
  tenant_id STRING NOT NULL,
  agent_id STRING NOT NULL,
  tool_name STRING NOT NULL,
  request_id STRING NOT NULL,
  payload_hmac BYTES NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, tool_name, request_id),
  CONSTRAINT tool_requests_tool_name_ck CHECK (tool_name IN ('remember', 'pin', 'log_event'))
)
