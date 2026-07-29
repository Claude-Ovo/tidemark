# P0-02 CockroachDB migrations

This directory is the executable schema for SPEC v1.2.2.1.

## Run

From the repository root on Node.js 22+:

```powershell
node --env-file=.env migrations/apply.mjs --database tidemark_dev --create-database
node --env-file=.env migrations/apply.mjs --database tidemark_dev
node --env-file=.env migrations/verify.mjs --database tidemark_dev
```

`COCKROACH_DATABASE_URL` is read from the environment and is never printed. `--database` accepts only lowercase letters, digits, and underscores. `--create-database` is explicit and requires `--database`.

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
