// Machine-enforced preconditions for destructive migrations. applyOne runs the
// matching check right before FIRST application of that version (already-applied
// versions never re-run it). A throw aborts the whole migrate run -- fail-closed.
//
// The 013->017 upgrade story for legacy outcomes (rows settled by the pre-013
// implementation, whose payload_hmac + first response live ONLY in
// tool_requests.tool_name='report_outcome'):
//   014 deletes those tool_requests rows  -> EARLIEST destruction point
//   016 deletes NULL-evidence outcomes    -> second destruction point
//   017 requires both columns NOT NULL
// So 014 must refuse while evidence still exists (backfill is the correct
// recovery), and 016 must refuse if NULL rows somehow still exist (evidence is
// gone by then -- mark rows unreplayable, NEVER delete them: deleting an
// outcome row reopens its idempotency claim and frees its terminal slot).

const LEGACY_OUTCOMES_SQL =
  'SELECT count(*)::INT4 AS n FROM public.outcomes WHERE payload_hmac IS NULL OR response_json IS NULL'

export const PREFLIGHTS = {
  // Refuse BEFORE deleting tool_requests copies while any outcome still lacks
  // its evidence. At this point the evidence exists -- recovery is backfill.
  14: async (client) => {
    const n = (await client.query(LEGACY_OUTCOMES_SQL)).rows[0].n
    if (n > 0) {
      throw new Error(
        `PREFLIGHT 014 REFUSED: ${n} outcome row(s) still lack idempotency evidence, and 014 would ` +
        'delete the only copies (tool_requests.tool_name=\'report_outcome\'). Recover by BACKFILL -- ' +
        'the evidence still exists: UPDATE public.outcomes o SET payload_hmac = tr.payload_hmac, ' +
        'response_json = tr.response_json FROM public.tool_requests tr WHERE tr.tenant_id = o.tenant_id ' +
        'AND tr.agent_id = o.agent_id AND tr.tool_name = \'report_outcome\' AND tr.request_id = o.outcome_request_id ' +
        'AND (o.payload_hmac IS NULL OR o.response_json IS NULL); verify the legacy count is zero, then re-run ' +
        'migrate (014 then only removes redundant copies). Rows with no matching tool_request must instead be ' +
        'marked unreplayable -- see PREFLIGHT 016 instructions. Never delete outcome rows: deletion reopens ' +
        'the idempotency claim and frees the terminal attempt slot.',
      )
    }
  },
  // 022 backfills the lifecycle due-clock from strength_anchor_at. A future
  // anchor on an eligible row would be laundered into a "legitimate" far-future
  // schedule -- conclusion 10 forbids clamping or hiding it. Fail closed.
  22: async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::INT4 AS n FROM public.memories
       WHERE admission = 'accepted' AND NOT pinned AND state <> 'faded'
         AND next_transition_at IS NULL AND strength_anchor_at > now()`,
    )
    const n = rows[0].n
    if (n > 0) {
      throw new Error(
        `PREFLIGHT 022 REFUSED: ${n} eligible row(s) carry a FUTURE strength_anchor_at; backfilling ` +
        'would launder the contamination into a far-future schedule (conclusion 10: never clamp). ' +
        'Investigate how the future timestamps were written, repair them explicitly (e.g. restore from ' +
        'a known-good anchor or re-anchor via an audited materialize), then re-run migrate. Do not ' +
        'rewrite timestamps blindly and do not exclude the rows just to make the migration pass.',
      )
    }
  },
  // Defense in depth: reaching 016 with NULL rows means 014 already ran (or was
  // bypassed) and the tool_requests evidence is gone. Mark, never delete.
  16: async (client) => {
    const n = (await client.query(LEGACY_OUTCOMES_SQL)).rows[0].n
    if (n > 0) {
      throw new Error(
        `PREFLIGHT 016 REFUSED: ${n} outcome row(s) lack idempotency evidence and the tool_requests ` +
        'copies are gone (014 already applied). Do NOT delete these rows -- deletion reopens their ' +
        'idempotency claims and frees their terminal attempt slots. Instead mark them permanently ' +
        'unreplayable: UPDATE public.outcomes SET payload_hmac = \'\\x00\', ' +
        'response_json = \'{"legacy_outcome_unreplayable": true}\' WHERE payload_hmac IS NULL OR ' +
        'response_json IS NULL; then re-run migrate (016 becomes a no-op, 017 NOT NULL is satisfied). ' +
        'Replays of these request ids will fail closed as legacy_outcome_unreplayable forever; their ' +
        'attempt slots stay occupied. Optionally archive the rows first for offline reference.',
      )
    }
  },
}
