-- Backfill the lifecycle due-clock for rows written before P0-06 (conclusion 39
-- debt). Same three branches as the canonical scheduler (src/lib/scheduler.mjs),
-- pure SQL, single statement, idempotent (WHERE next_transition_at IS NULL):
--   ineligible (quarantined/rejected admission, pinned, faded) -> stays NULL
--   fresh with consolidation progress >= 3                      -> now() (immediately due)
--   anchor <= 0.15                                              -> now() (already past fade crossing)
--   otherwise -> analytic fade crossing:
--     strength_anchor_at + half_life_hours * log2(anchor / 0.15) hours
-- Constants frozen per channel conclusion pending (fade=0.15, hits=3).
-- PREFLIGHTS[22] refuses eligible rows with future strength_anchor_at first
-- (conclusion 10: never clamp, never launder a future anchor into a schedule).
UPDATE public.memories SET next_transition_at = CASE
    WHEN state = 'fresh' AND credited_success_count - consolidation_baseline >= 3 THEN now()
    WHEN strength_anchor <= 0.15 THEN now()
    ELSE strength_anchor_at + (half_life_hours * (ln(strength_anchor / 0.15) / ln(2::FLOAT8))) * INTERVAL '1 hour'
  END
  WHERE next_transition_at IS NULL
    AND admission = 'accepted' AND NOT pinned AND state <> 'faded'
