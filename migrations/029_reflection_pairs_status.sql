-- P0-07 code review item 5: oversized (input_too_large) pairs need a durable,
-- auditable terminal decision so they stop re-entering every night's scan.
-- status='skipped_input_too_large' rows carry NULL experience_id -- the
-- resolved/experience pairing invariant is enforced by the CHECK.
ALTER TABLE public.reflection_pairs
  ADD COLUMN IF NOT EXISTS status STRING NOT NULL DEFAULT 'resolved' CHECK (status IN ('resolved', 'skipped_input_too_large')),
  ALTER COLUMN experience_id DROP NOT NULL,
  ADD CONSTRAINT rp_status_experience_ck CHECK ((status = 'resolved') = (experience_id IS NOT NULL))
