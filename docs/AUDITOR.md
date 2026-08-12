# Auditor Mode (P0-10)

An **operator-facing, read-only audit path** into Tidemark's memory lifecycle, designed for
the CockroachDB **Managed MCP Server** on an isolated demo cluster (conclusions 18/25).
The auditor can trace every claim the system makes — *which memories were recalled, why,
what outcome credited them, and which nightly run produced a derived memory* — without ever
seeing stored prose, vectors, or credentials.

Scope note (honest): the recall/plasticity queries (1, 2) return live product rows today.
The provenance queries (3a, 3b) exercise live schema + red-gate-tested joins, but return
**zero product rows this cycle** — the dream/reflection generating model segment is
blocked_external (Bedrock denied; stub validates the state machine only). Empty results
there are the honest state, not a broken query.

## The account

`tidemark_auditor` (created by `infra/setup-auditor.mjs`; prod credentials sealed in
Secrets Manager `tidemark/auditor`, never in the repo).

What it can see — exactly 12 **application** relations (standard CockroachDB catalogs —
`pg_catalog` / `information_schema` / `crdb_internal` — remain platform-default,
privilege-filtered and credential-masked; e.g. `pg_shadow.passwd` is a fixed mask and
cluster views show only the auditor's own sessions):

| Relation | What it proves |
|---|---|
| `audit_memories` | lifecycle truth (state/strength/counters/identity) with `content`/`embedding`/`experience_body` replaced by presence+size markers |
| `audit_recalls` | persisted content-free receipts; the debug-only `query_preview` masked to a flag |
| `audit_nightly_runs` | run/lease/fingerprint state; free-text `error_message` masked to a flag |
| `audit_memory_rebuild_queue` | rebuild ledger with the unconstrained free-text `last_error` masked to a flag |
| `attempt_events`, `outcomes`, `memory_derivations`, `memory_event_evidence`, `reflection_pairs`, `memory_tombstones`, `success_evidence`, `reflection_cursor` | content-free by frozen write-hygiene design — granted as-is |

What it cannot do — verified by `src/test-auditor.mjs` (A1-A7: readable surface, denials, exact frozen column surface of all 12 relations, free-text sentinel unreachability, grant-drift convergence red gates with live injections incl. public-role and SYSTEM grants with fail-path-safe cleanup postconditions (A6b-post), and the A7 provenance cross-pairing gate): read the three prose-bearing
base tables (42501), any INSERT/UPDATE/DELETE (42501), any DDL (the CockroachDB default
`public`-role schema CREATE grant is explicitly revoked — found live by test A3), or see any
banned column through a view.

## Judge queries (copy-paste)

**1. "Show me the receipt" — everything a recall claimed, content-free:**

```sql
SELECT request_id, agent_id, episode_id, outcome_state, pipeline_version,
       receipt_json->'receipt'->'items' AS items, serialization_checksum
FROM audit_recalls
WHERE tenant_id = 'demo-tenant'
ORDER BY created_at DESC LIMIT 5;
```

Every item carries similarity/effective-strength/utility/final-score components and the
exact `pipeline_version` (including the full embedding-model identity) that produced it.

**2. "Who credited this memory?" — outcome-gated plasticity, honestly stated:**

```sql
SELECT m.memory_id, m.state, m.pinned, m.credited_success_count, m.evidenced_blame_count,
       m.strength_anchor, m.half_life_hours, m.embedding_model_id,
       count(o.outcome_request_id) FILTER (WHERE o.status = 'success'
         AND o.attributions @> ('[{"memory_id":"' || m.memory_id || '","role":"credited"}]')::JSONB) AS credited_outcomes,
       count(o.outcome_request_id) FILTER (WHERE o.status = 'failure'
         AND o.attributions @> ('[{"memory_id":"' || m.memory_id || '","role":"blamed"}]')::JSONB) AS blamed_outcomes
FROM audit_memories m
LEFT JOIN outcomes o
  ON o.tenant_id = m.tenant_id
 AND o.attributions @> ('[{"memory_id":"' || m.memory_id || '"}]')::JSONB
WHERE m.tenant_id = 'demo-tenant'
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
ORDER BY m.credited_success_count DESC, m.memory_id LIMIT 10;
```

Honest scope: anchors also move without outcomes **by design** (initial strength on
remember/derive, pin materialization, lifecycle transitions). What is outcome-gated is
**credit and blame**: any row with `credited_success_count > 0` or
`evidenced_blame_count > 0` must show matching `credited_outcomes` / `blamed_outcomes`
respectively (direction matters: a credit counter backed only by failure attributions would
be a lie) — a nonzero counter with zero matching rows falsifies the design on the spot.

**3a. "Where did this dream memory come from?" — memory-to-memory lineage:**

```sql
SELECT d.derived_memory_id, d.source_memory_id, r.run_id, r.job_kind, r.scheduled_for,
       r.pipeline_version, r.status, r.source_fingerprint
FROM memory_derivations d
JOIN audit_nightly_runs r ON r.tenant_id = d.tenant_id AND r.run_id = d.run_id
WHERE d.tenant_id = 'demo-tenant'
ORDER BY r.scheduled_for DESC LIMIT 10;
```

**3b. "Where did this experience come from?" — reflection lineage runs through EVENTS:**

```sql
SELECT e.derived_memory_id AS experience_id, e.attempt_id, e.event_id,
       p.failure_attempt_id, p.success_attempt_id, p.status AS pair_status,
       r.run_id, r.job_kind, r.scheduled_for, r.pipeline_version
FROM memory_event_evidence e
JOIN audit_nightly_runs r ON r.tenant_id = e.tenant_id AND r.run_id = e.run_id
LEFT JOIN reflection_pairs p ON p.tenant_id = e.tenant_id AND p.experience_id = e.derived_memory_id
  AND p.run_id = e.run_id AND e.attempt_id IN (p.failure_attempt_id, p.success_attempt_id)
WHERE e.tenant_id = 'demo-tenant'
ORDER BY r.scheduled_for DESC LIMIT 10;
```

Dream products chain through `memory_derivations`; reflection products anchor to the exact
attempt EVENTS they were extracted from (`memory_event_evidence`) plus the exactly-once
pair ledger — the `run_id` + attempt constraints matter: when semantic dedup resolves two
pairs to one experience, the unconstrained join would cross-pair every event with every
pair (proven by red gate A7). Both end at an idempotent, lease-fenced run with a frozen source fingerprint —
no orphaned "the model just said so" rows.

## Wiring the Managed MCP Server (live as of 2026-08-12 — see docs/EVIDENCE-MANAGED-MCP-0812.md)

Procedure: the CockroachDB Cloud console configures the Managed MCP endpoint with the
`tidemark_auditor` SQL credentials (console step, operator-performed). The MCP tools are
the official fixed 12 (read/query); with this account the APPLICATION data they can reach
is exactly the relations above (platform catalogs stay privilege-filtered as noted).
Business traffic never touches this path — it stays on Tidemark's own Memory MCP
(conclusion 18).

**Status (2026-08-12)**: the Managed MCP endpoint is wired to cluster `brief-herring` and
evidenced live — an MCP client authorized through the Cloud console OAuth flow ran the
official read-only tools and read all four audit views out of `tidemark_prod`
(`docs/EVIDENCE-MANAGED-MCP-0812.md`), closing the operator-capture gap of conclusion 57.

Two claims stay separate on purpose. That capture connected as the **Cloud principal**
(`current_user` = `managed-mcp`), which is what the console OAuth flow grants. The
**`tidemark_auditor` least-privilege face** described above — four views, eight
content-free ledgers, no base-table or content reach — is proven by its own red gates
(A1–A7, `src/test-auditor.mjs`), not by that capture. Pointing the Managed MCP endpoint at
the auditor credentials instead of the Cloud principal remains the documented procedure
above; we do not claim it as evidenced.
