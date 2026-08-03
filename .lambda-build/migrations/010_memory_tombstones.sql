CREATE TABLE IF NOT EXISTS public.memory_tombstones (
  tenant_id STRING NOT NULL,
  memory_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason STRING,
  PRIMARY KEY (tenant_id, memory_id)
)
