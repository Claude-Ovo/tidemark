-- Tighten 013's columns now that 016 guarantees no NULL rows. Runtime note:
-- the INSERT writes a '{}' placeholder for response_json and the same
-- transaction backfills the real response after promotions are computed --
-- SERIALIZABLE commit means no reader ever observes the placeholder.
ALTER TABLE public.outcomes
  ALTER COLUMN payload_hmac SET NOT NULL,
  ALTER COLUMN response_json SET NOT NULL
