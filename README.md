# Tidemark

**A memory organ that learns from outcomes, not repetition — and proves every recall.**

An outcome-gated memory layer for AI agents, built on CockroachDB (distributed vector indexing + managed MCP audit path) and AWS (Lambda, EventBridge, Bedrock). CockroachDB × AWS Hackathon 2026 entry.

Design docs: `docs/SPEC.md` (implementation contract, frozen v1.2.2.1) · `docs/ARCHITECTURE.md` · decision log in `collab/CODEX_CHANNEL.md`.

## Run (development)

Prerequisites: Node.js 22+, a CockroachDB Cloud cluster.

```powershell
# 1. Configure: copy .env.example to .env, paste your CockroachDB connection string.
#    Set TIDEMARK_HMAC_KEY to a non-empty secret. For LOCAL DEVELOPMENT ONLY you may
#    instead set TIDEMARK_DEV_INSECURE=1 (the server refuses to start with neither).
#    Production runs on Secrets Manager instead - see "Deploy (AWS)" below.

# 2. Create schema (idempotent; ledger-tracked):
npm run migrate -- --database tidemark_dev --create-database
npm run verify:migrations -- --database tidemark_dev

# 3. Start the Memory MCP server (stub embeddings until Bedrock allowlisting clears):
$env:EMBED_PROVIDER="stub"; $env:TIDEMARK_POOL_MAX="10"; $env:TIDEMARK_DEV_INSECURE="1"
node --env-file=.env src/server.mjs           # listens on :3901

# 4. Tests:
npm test                                      # static checks + unit suites (no DB/server needed)
npm run test:remember                         # integration acceptance - REQUIRES the server from step 3
```

Notes:
- `TIDEMARK_POOL_MAX` defaults to 1 (one connection per Lambda execution environment). The local
  dev server is a single process, so 10 mirrors the account-level concurrency budget (10 x 1).
- Numbered migration files are immutable once published; the runner refuses checksum drift.
- `spike/` contains the signed P0-01 AWS runtime spike (Lambda + API Gateway); see `docs/SPIKE-MCP.md`.

## Deploy (AWS)

One idempotent script provisions or updates everything (P0-09):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infra\deploy.ps1
# then prove the deployment end to end over the public URL:
node --env-file=.env infra/smoke.mjs <api-url-printed-by-deploy>
```

What it creates (all create-or-update; reruns are safe):

| Resource | Name | Notes |
|---|---|---|
| Secrets Manager secret | `tidemark/prod` | DB URL, HMAC key, admin key, agent API keys. Generated once by `infra/gen-secret.mjs`; values are preserved on redeploy (`-RotateSecrets` regenerates). Credentials never enter argv, function config, or the repo. |
| IAM role | `tidemark-prod-role` | Basic execution + `GetSecretValue` on the one secret + `bedrock:InvokeModel` on the Titan embed model. |
| Lambda | `tidemark-mcp` | The Memory MCP server (same `src/server.mjs` as local, wrapped by `src/aws/mcp-handler.mjs`). 30s / 512MB / pool max=1. |
| Lambda | `tidemark-nightly` | Dream -> reflection -> transition orchestrator (`src/aws/nightly-handler.mjs`). 600s. |
| API Gateway HTTP API | `tidemark-api` | `$default` -> `tidemark-mcp`. |
| EventBridge rule | `tidemark-nightly` | `cron(0 19 * * ? *)` (03:00 Beijing). Event time is floored to the minute into the canonical `scheduled_for`, so duplicate/retried deliveries land on the same `nightly_runs` key and commit exactly once (proved online by smoke S11). |

The prod database (`tidemark_prod`) is migrated + verified from your machine as part of the deploy. Functions receive only `TIDEMARK_SECRET_ARN`; secrets are pulled at cold start (`src/lib/secrets.mjs`, allowlisted keys, fail-closed).

Flipping to real Bedrock after allowlisting: set `EMBED_PROVIDER=bedrock` (and `DREAM_PROVIDER=bedrock` for nightly) in the function env - no code change.

## Admin surface (owner-only, not an agent tool)

The agent face is frozen at 5 MCP tools. Destructive owner operations live on a separate HTTP route with their own key:

```
POST /admin/forget        headers: x-tidemark-admin: <TIDEMARK_ADMIN_KEY>
body: { "tenant_id": "...", "memory_id": "<uuid>", "reason": "<slug>" }
```

Hard-deletes the memory row and every derived descendant (recursive lineage cascade), leaves content-free tombstones (`memory_id` + slug reason only - no content hashes), registers rebuild entries for cascaded derived memories that still have surviving sources, and revokes rebuild authorization for anything explicitly forgotten (generation-fenced against in-flight workers). Idempotent: forgetting an already-forgotten id returns `already_forgotten`. Auth is fail-closed: without `TIDEMARK_ADMIN_KEY` configured (or explicit `TIDEMARK_DEV_INSECURE=1`, dev key `dev-admin`), the route refuses everything.

Agent API keys map to `{tenant, agent, capabilities}` server-side (`TIDEMARK_AGENT_KEYS` from the secret; hardcoded dev keys exist only when it is absent). `memory:pin` is a capability bit, not a default right.

## License

MIT (license file added before submission).
