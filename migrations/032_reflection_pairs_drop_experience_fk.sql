-- The experience FK (self-imposed in 027, not required by review) breaks the
-- atomic-claim-before-side-effects ordering from code review item 6 (the
-- ledger row must land BEFORE the experience insert) and would also block
-- P0-08 hard-delete cascades. The ledger is an audit record: like receipts,
-- it may legitimately point at a later-deleted experience. Application code
-- guarantees liveness at write time. The run FK (030) stays.
ALTER TABLE public.reflection_pairs DROP CONSTRAINT IF EXISTS rp_experience_fk
