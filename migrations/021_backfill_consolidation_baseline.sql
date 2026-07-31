-- Existing rows earned their credited counts before progress semantics existed
-- (P0-05 test-era counts included). Baseline = current count resets every
-- existing row's progress to zero -- conservative and honest: nothing gets
-- consolidated on the strength of pre-P0-06 history. Idempotent: rerun only
-- touches rows where the two still differ and baseline is still zero.
UPDATE public.memories SET consolidation_baseline = credited_success_count
  WHERE consolidation_baseline = 0 AND credited_success_count > 0
