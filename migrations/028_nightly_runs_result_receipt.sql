-- Dream Receipt output side (Codex suggestion, adopted): per-cluster provider/
-- model/prompt version, schema version, and output checksum land here AFTER
-- generation -- never written back into the immutable source_snapshot and
-- never mixed into control_config. Nullable: the input side of the receipt is
-- source_snapshot itself, and the output side may be filled as P1 without
-- blocking P0-07.
ALTER TABLE public.nightly_runs ADD COLUMN IF NOT EXISTS result_receipt JSONB
