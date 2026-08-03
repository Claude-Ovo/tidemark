-- Control-plane snapshot per run (Codex plan review round-2 #3): lease and
-- attempt policy are frozen into the run row at claim time -- takeover and
-- exhaustion decisions read the row, never the current environment, so a
-- process restart with new env vars cannot silently change an old run's
-- contract. Kept separate from source_snapshot, which stays pure source
-- canonical input. NOT NULL with '{}' default keeps 006's existing zero rows
-- valid. The transition job always writes an explicit config.
ALTER TABLE public.nightly_runs ADD COLUMN IF NOT EXISTS control_config JSONB NOT NULL DEFAULT '{}'
