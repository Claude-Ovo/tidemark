-- Companion to 036. The (tenant, agent) prefix vector index is superseded by
-- mem_vec_id_idx whose prefix carries embedding_model_id. No query references
-- mem_vec_idx once recall pins the identity-prefixed index.
DROP INDEX IF EXISTS public.memories@mem_vec_idx
