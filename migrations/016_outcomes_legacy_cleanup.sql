-- Roll-forward for the 013/014 upgrade gap: outcomes rows created before 013
-- carry NULL payload_hmac/response_json and their original claim evidence was
-- removed by 014, so exact replay is impossible for them. Verified before
-- writing this migration: current dev/demo environments hold ZERO such rows
-- (outcomes was empty), so this delete is a no-op guard, not data loss. Any
-- environment where legacy rows DO exist must restore from backup instead of
-- pretending replay works. Prerequisite for 017's NOT NULL tightening.
DELETE FROM public.outcomes WHERE payload_hmac IS NULL OR response_json IS NULL
