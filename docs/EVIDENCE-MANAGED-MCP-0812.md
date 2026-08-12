# Evidence: CockroachDB Cloud Managed MCP Server — live operator capture

**Captured**: 2026-08-12 01:44:38 UTC (09:44 Asia/Shanghai)
**Cluster**: `brief-herring` — `6127232c-57a6-4606-acc0-42ba8bee0931`, AWS `us-west-2`, plan BASIC, CockroachDB `v26.2.5`
**Endpoint**: `https://cockroachlabs.cloud/mcp`, header `mcp-cluster-id: 6127232c-57a6-4606-acc0-42ba8bee0931`
**Client**: Claude Code, server registered as `cockroachdb-cloud`; operator completed the OAuth
authorization interactively (`/mcp` → Authenticate). This closes the operator-capture gap that
`docs/AUDITOR.md` and the capability index had left open (conclusion 57).

## What was exercised

The official fixed Managed MCP tool set — not a Tidemark-authored tool. Calls made:
`get_cluster`, `list_databases`, `list_tables`, `select_query`. All read-only.

### 1. `get_cluster`

```json
{"id":"6127232c-57a6-4606-acc0-42ba8bee0931","name":"brief-herring","cockroach_version":"v26.2.5",
 "cloud_provider":"AWS","state":"CREATED","plan":"BASIC",
 "regions":[{"name":"us-west-2","node_count":0}],
 "created_at":"2026-07-28T21:56:39Z","updated_at":"2026-08-07T07:56:59Z"}
```

### 2. `list_databases`

`defaultdb`, `tidemark_dev`, `tidemark_prod`, plus two migration-rehearsal databases
(`tidemark_mig_20368_a15d116b`, `tidemark_mig_51320_567d51b6`), all `REGIONAL BY TABLE`
in `aws-us-west-2` with `survival_goal: zone`.

### 3. `list_tables` on `tidemark_prod`

14 base tables and — the point of this capture — the four sanitized audit views are visible
through the Managed MCP path:

| relation | type |
| --- | --- |
| `audit_memories` | view |
| `audit_recalls` | view |
| `audit_nightly_runs` | view |
| `audit_memory_rebuild_queue` | view |

### 4. `select_query` on `tidemark_prod`

```sql
SELECT (SELECT count(*) FROM audit_memories)             AS audit_memories,
       (SELECT count(*) FROM audit_recalls)              AS audit_recalls,
       (SELECT count(*) FROM audit_nightly_runs)         AS audit_nightly_runs,
       (SELECT count(*) FROM audit_memory_rebuild_queue) AS audit_rebuild_queue,
       (SELECT count(*) FROM memories)                   AS memories,
       (SELECT count(*) FROM tool_requests)              AS tool_requests,
       now()::string AS observed_at, current_user AS via_user, version() AS crdb_version;
```

```json
{"audit_memories":12,"audit_recalls":36,"audit_nightly_runs":12,"audit_rebuild_queue":0,
 "memories":12,"tool_requests":110,
 "observed_at":"2026-08-12 01:44:38.776923+00","via_user":"managed-mcp",
 "crdb_version":"CockroachDB CCL v26.2.5 (x86_64-pc-linux-gnu, built 2026/07/28 18:56:00, go1.25.5)"}
```

`audit_memories` (12) agrees with the base `memories` count (12) — the sanitized view is the
same population with content columns stripped, not a different or empty slice.

## What this does and does not prove

**Proves**: the Managed MCP server is wired to this cluster, an MCP client authorized through the
Cloud console OAuth flow, and the official read-only tools return real rows from `tidemark_prod`,
including the four audit views. That is the second CockroachDB tool for the submission, exercised
rather than described.

**Does not prove**: this session connected as the Cloud principal (`current_user` = `managed-mcp`),
not as the `tidemark_auditor` SQL role. The auditor least-privilege face — four views, eight
content-free ledgers, no base-table or content access — remains proven by its own red gates
(A1–A7, `src/test-auditor.mjs`), not by this capture. The two facts are kept separate on purpose;
`docs/AUDITOR.md` states the auditor-credential wiring as a documented procedure.

**Business traffic** never traverses this path. Tidemark's own Memory MCP on Lambda serves the
application; the Managed MCP path is operator-facing audit only (conclusion 18).
