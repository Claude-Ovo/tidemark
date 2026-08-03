-- Conclusion 55 hard contract, applied only after backfill-embeddings.mjs proved residual zero.
-- Any row that carries a vector must be attributable to the exact space that produced it.
-- Quarantined rows carry no embedding and stay exempt by construction.
ALTER TABLE public.memories ADD CONSTRAINT IF NOT EXISTS memories_embedding_identity_ck CHECK (embedding IS NULL OR embedding_model_id IS NOT NULL)
