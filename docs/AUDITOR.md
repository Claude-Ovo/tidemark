# Auditor Mode (P0-10)

An **operator-facing, read-only audit path** into Tidemark's memory lifecycle, designed for
the CockroachDB **Managed MCP Server** on an isolated demo cluster (conclusions 18/25).
The auditor can trace every claim the system makes — *which memories were recalled, why,
what outcome credited them, and which nightly run produced a derived memory* — without ever
seeing stored prose, vectors, or credentials.

## The account

`tidemark_auditor` (created by `infra/setup-auditor.mjs`; prod credentials sealed in
Secrets Manager `tidemark/auditor`, never in the repo).

What it can see — exactly 12 relations:

| Relation | What it proves |
|---|---|
| `audit_memories` | lifecycle truth (state/strength/counters/identity) with `content`/`embedding`/`experience_body` replaced by presence+size markers |
| `audit_recalls` | persisted content-free receipts; the debug-only `query_preview` masked to a flag |
| `audit_nightly_runs` | run/lease/fingerprint state; free-text `error_message` masked to a flag |
| `attempt_events`, `outcomes`, `memory_derivations`, `memory_event_evidence`, `reflection_pairs`, `memory_tombstones`, `memory_rebuild_queue`, `success_evidence`, `reflection_cursor` | content-free by frozen write-hygiene design — granted as-is |

What it cannot do — verified by `src/test-auditor.mjs` (A1-A4): read the three prose-bearing
base tables (42501), any INSERT/UPDATE/DELETE (42501), any DDL (the CockroachDB default
`public`-role schema CREATE grant is explicitly revoked — found live by test A3), or see any
banned column through a view.

## Three judge queries (copy-paste)

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

**2. "Why is this memory strong?" — outcome-gated plasticity, item by item:**

```sql
SELECT m.memory_id, m.state, m.pinned, m.credited_success_count, m.evidenced_blame_count,
       m.strength_anchor, m.half_life_hours, m.embedding_model_id,
       o.outcome_request_id, o.status, o.reported_at, o.attributions
FROM audit_memories m
JOIN outcomes o
  ON o.tenant_id = m.tenant_id
 AND o.attributions @> ('[{"memory_id":"' || m.memory_id || '"}]')::JSONB
WHERE m.tenant_id = 'demo-tenant'
ORDER BY o.reported_at DESC LIMIT 10;
```

Strength never moves without an attribution row behind it — this join IS the proof.

**3. "Where did this derived memory come from?" — nightly provenance end to end:**

```sql
SELECT d.derived_memory_id, d.source_memory_id, r.run_id, r.job_kind, r.scheduled_for,
       r.pipeline_version, r.status, r.source_fingerprint, r.result_receipt
FROM memory_derivations d
JOIN audit_nightly_runs r ON r.tenant_id = d.tenant_id AND r.run_id = d.run_id
WHERE d.tenant_id = 'demo-tenant'
ORDER BY r.scheduled_for DESC LIMIT 10;
```

Dream/reflection products chain back to an idempotent, lease-fenced run with a frozen
source snapshot — no orphaned "the model just said so" rows.

## Wiring the Managed MCP Server

The CockroachDB Cloud console configures the Managed MCP endpoint with the
`tidemark_auditor` SQL credentials (console step, operator-performed). The MCP tools are
the official fixed 12 (read/query); with this account they can only reach the relations
above. Business traffic never touches this path — it stays on Tidemark's own Memory MCP
(conclusion 18).
