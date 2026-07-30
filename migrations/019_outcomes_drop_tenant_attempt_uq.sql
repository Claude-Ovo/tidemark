-- Companion to 018: the tenant-global attempt uniqueness is the vulnerability
-- itself (cross-agent terminal-slot squatting), so it must go, not coexist.
-- Declared inside CREATE TABLE (004), so CRDB treats it as a unique
-- constraint -- DROP CONSTRAINT removes the backing index with it.
ALTER TABLE public.outcomes DROP CONSTRAINT IF EXISTS outcomes_attempt_uq
