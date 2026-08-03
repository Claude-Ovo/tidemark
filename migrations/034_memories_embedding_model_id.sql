-- P0 local-onnx pivot, conclusion 55. Every embedded row must be attributable to the exact
-- vector space that produced it. Old stub rows and local-onnx rows must never share a
-- retrieval space, so recall filters on the CURRENT identity and the backfill re-embeds
-- legacy accepted rows. Nullable by design at this stage. Quarantined rows carry no
-- embedding and pre-backfill accepted rows are temporarily NULL. The accepted-row NOT NULL
-- contract lands as a CHECK in migration 035 only after the backfill proves count zero.
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS embedding_model_id STRING NULL
