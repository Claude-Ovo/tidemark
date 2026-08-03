-- Conclusion 55. The vector index prefix gains embedding_model_id so each embedding space is
-- its own sub-index: recall filters the CURRENT identity as a prefix column and the planner
-- keeps using the forced vector index (adding the predicate to the old (tenant, agent) prefix
-- index fails with 42809 "index cannot be used for this query"). Old index dropped in 037
-- after this one exists, so there is no window without a vector index.
CREATE VECTOR INDEX IF NOT EXISTS mem_vec_id_idx ON public.memories (tenant_id, agent_id, embedding_model_id, embedding vector_cosine_ops)
