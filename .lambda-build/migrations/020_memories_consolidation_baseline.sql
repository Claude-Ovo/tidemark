-- P0-06 consolidation progress (Codex plan review #3): credited_success_count
-- is lifetime utility evidence and must never be reset. Consolidation progress
-- is a separate notion: progress = credited_success_count - consolidation_baseline.
-- Baseline update points (SPEC v1.2.4 2.4): create=0, fade=count, revive=count
-- (the reviving credit itself earns no progress -- re-earn from zero), consolidate=count.
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS consolidation_baseline INT8 NOT NULL DEFAULT 0
