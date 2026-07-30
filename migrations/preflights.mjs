// Machine-enforced preconditions for destructive migrations. applyOne runs the
// matching check right before FIRST application of that version (already-applied
// versions never re-run it). A throw aborts the whole migrate run -- fail-closed.
export const PREFLIGHTS = {
  // 016 deletes outcomes rows whose idempotency evidence (payload_hmac /
  // response_json) is NULL. Those are pre-013 legacy audit rows; deleting them
  // is destructive and this runner refuses to do it implicitly.
  16: async (client) => {
    const { rows } = await client.query(
      'SELECT count(*)::INT4 AS n FROM public.outcomes WHERE payload_hmac IS NULL OR response_json IS NULL',
    )
    const n = rows[0].n
    if (n > 0) {
      throw new Error(
        `PREFLIGHT 016 REFUSED: ${n} legacy outcome row(s) carry NULL idempotency evidence; ` +
        'applying 016 would destroy audit rows. Manual path: 1) archive them, e.g. ' +
        'CREATE TABLE public.outcomes_legacy_archive AS SELECT * FROM public.outcomes ' +
        'WHERE payload_hmac IS NULL OR response_json IS NULL; 2) verify the archive row count; ' +
        '3) delete the originals yourself; 4) re-run migrate. Replay for archived requests will ' +
        'honestly fail as legacy_outcome_unreplayable -- do not fabricate evidence to bypass this.',
      )
    }
  },
}
