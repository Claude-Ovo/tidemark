# P0-02 CockroachDB migrations

This directory is the executable schema for SPEC v1.2.3.

## Run

From the repository root on Node.js 22+:

```powershell
node --env-file=.env migrations/apply.mjs --database tidemark_dev --create-database
node --env-file=.env migrations/apply.mjs --database tidemark_dev
node --env-file=.env migrations/verify.mjs --database tidemark_dev
```

`COCKROACH_DATABASE_URL` is read from the environment and is never printed. `--database` accepts only lowercase letters, digits, and underscores; when omitted, resolution is `--database` > `TIDEMARK_DATABASE` > `tidemark_dev` (matching the service layer). `--create-database` is explicit and requires `--database`.

## Destructive migrations and preflights

For legacy outcomes settled by the pre-013 implementation, the idempotency evidence (`payload_hmac` + first response) lives ONLY in `tool_requests.tool_name='report_outcome'`. The upgrade sequence has two destruction points: **014** deletes those `tool_requests` rows (the earliest), and **016** deletes NULL-evidence `outcomes` rows. `preflights.mjs` fail-closes BOTH before their first application (`applyOne` runs the check before the destructive statement; already-applied versions never re-check). Recovery depends on where the run stopped:

- **Refused at 014 (evidence still exists)**: backfill it into `outcomes` -- `UPDATE public.outcomes o SET payload_hmac = tr.payload_hmac, response_json = tr.response_json FROM public.tool_requests tr WHERE tr.tenant_id = o.tenant_id AND tr.agent_id = o.agent_id AND tr.tool_name = 'report_outcome' AND tr.request_id = o.outcome_request_id AND (o.payload_hmac IS NULL OR o.response_json IS NULL)` -- verify zero legacy rows remain, then re-run migrate. 014 then only removes redundant copies; exact replay keeps working.
- **Refused at 016 (evidence already gone)**: mark the rows permanently unreplayable -- `UPDATE public.outcomes SET payload_hmac = '\x00', response_json = '{"legacy_outcome_unreplayable": true}' WHERE payload_hmac IS NULL OR response_json IS NULL` -- then re-run migrate. The application recognizes the marker and fails those request ids closed as `legacy_outcome_unreplayable` forever.

**Never delete an `outcomes` row during recovery.** Deleting one reopens its idempotency claim (`readPrior` misses, the same `outcome_request_id` would be processed as brand new) and frees its terminal attempt slot. The marker keeps both permanently occupied. Archiving copies for offline reference is fine; deletion of the live row is not.

Historical note: 016's in-file comment predates this preflight mechanism and still calls itself a "no-op guard". Numbered migrations are immutable (checksummed), so the file text stays; this section and `preflights.mjs` supersede that description. Integration regression: `npm run test:migrate-integration` replays the real upgrade (012-state + legacy row -> refused at 014 with evidence intact on both sides -> backfill -> full green).

Each numbered file contains exactly one idempotent schema-change statement. CockroachDB does not guarantee atomic rollback for multiple schema changes in one explicit transaction, so the runner applies one autocommit DDL statement and then records its LF-normalized SHA-256 in `schema_migrations`. A disconnect between DDL and ledger insert is repaired safely on rerun. An applied filename/checksum mismatch is fatal.

Numbered migration files are immutable once released. Add a new numbered migration instead of editing an existing file. Before any manual recovery in the narrow DDL-applied/ledger-missing window, first confirm the `schema_migrations` ledger state.

`schema_migrations` is global database control metadata and is the only table exempt from the domain rule that primary keys contain `tenant_id`.

## Tables

| Table | Purpose |
|---|---|
| `memories` | Event/experience content, lifecycle anchors, utility evidence counts, and `VECTOR(512)` embedding |
| `attempt_events` | Append-only item-bound evidence and reflection input |
| `recall_requests` | Idempotent recall receipt and serialization checksum |
| `outcomes` | Terminal task outcome and attribution payload |
| `tool_requests` | Idempotency ledger for remember/pin/log_event |
| `nightly_runs` | One bounded tenant/job batch, lease/CAS state, source snapshot/fingerprint, and model provenance |
| `memory_derivations` | Dream memory-to-memory provenance |
| `memory_event_evidence` | Reflection memory-to-attempt-event provenance |
| `success_evidence` | Candidate experience credit across distinct task instances |
| `memory_tombstones` | Content-free hard-delete marker |
| `memory_rebuild_queue` | Content-free P2 rebuild request with deleted derived ID and surviving source IDs |

No Row-Level TTL is enabled.

## Frozen-spec resolutions

- The P0-01 spike resolved the pending embedding dimension to 512, so `memories.embedding` and `mem_vec_idx` use `VECTOR(512)` with `vector_cosine_ops`.
- SPEC intentionally has no tenant or agent registry table; both IDs come from authenticated context and are carried in domain keys.
- The shorthand relation schemas omit `agent_id`. `memories_tenant_memory_uq (tenant_id, memory_id)` provides the tenant-scoped FK target without inventing relation columns. Authorization still enforces agent scope in the service.
- `nightly_runs` materializes decision-log conclusions 13/16/17: schedule uniqueness, bounded single batch, lease/status/attempt state, revision-bearing source snapshot, and unique source fingerprint. Bedrock remains outside database transactions.
- `memory_rebuild_queue` is deliberately content-free. It stores tenant/agent, the random deleted derived-memory ID, surviving source UUIDs, optional originating run, lease state, and no content/hash/embedding.
- `memory_derivations_source_fk` is restrictive while the derived-memory FK cascades. A source cannot be deleted directly while provenance remains; the owner/admin forget path must traverse and delete derived descendants first.
- `memory_derivations` treats an existing `(tenant_id, derived_memory_id, source_memory_id)` edge as an idempotent retry. Writers must not reuse a derived-memory ID for a different logical nightly/rebuild run.

## Verification

`verify.mjs` rolls every test back. It:

- checks all 11 domain tables and the migration ledger exist;
- proves every domain primary key and foreign key is tenant-scoped;
- requires every named domain `CHECK` to have a failing negative test;
- tests key unique constraints;
- attempts cross-tenant provenance/evidence/rebuild links and requires SQLSTATE `23503`.

The verification database should be isolated (`tidemark_dev` for this project). The script does not drop databases or tables and leaves no test rows.

References: [CockroachDB vector indexes](https://www.cockroachlabs.com/docs/stable/vector-indexes), [CockroachDB transaction guidance](https://www.cockroachlabs.com/docs/stable/begin-transaction).
