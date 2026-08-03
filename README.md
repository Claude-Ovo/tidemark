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

# 2b. Fetch + verify the sealed embedding model (once; ~23MB, SHA256-pinned by embed-manifest.json):
node infra/fetch-model.mjs                    # add NODE_USE_ENV_PROXY=1 on proxied networks

# 3. Start the Memory MCP server.
#    EMBED_PROVIDER: local-onnx (default; in-process MiniLM, real semantics)
#                    stub (tests only; hash pseudo-vectors) | bedrock (enterprise accounts, unverified)
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

## Embedding: self-hosted ONNX inside Lambda

Bedrock access was formally denied for this individual account (enterprise-only per the AWS
support case), so v1 runs its own inference: quantized `all-MiniLM-L6-v2` (q8 ONNX, 22MB,
Apache-2.0) executes **inside the Lambda** via transformers.js - no external AI API in the
request path at all. Details that matter:

- **Sealed artifacts**: `embed-manifest.json` pins the model commit + SHA256 of every file;
  `infra/fetch-model.mjs` verifies on download, the runtime re-verifies at cold start and
  refuses to serve on any mismatch. Remote model downloads are disabled at runtime.
- **Derived identity**: `embedding_model_id` is computed from the manifest + installed
  runtime versions (readable prefix + full 64-hex digest, `src/lib/embed-identity.mjs`).
  Every embedded row stores it; recall only searches the CURRENT identity (the vector index
  prefix includes it), so vector spaces can never mix. `GET /health` exposes the live value.
- **Truncation contract**: inputs beyond the tokenizer cap (512 wordpieces; the model's
  trained length is 256) are deterministically truncated and observably flagged
  (`embed_truncated` log + `truncated` in the embed result) - never silently passed off
  as fully embedded.
- **Numbers** (see docs/SPIKE-ONNX.md): cold start ~2.2s at 1024MB, warm 4-34ms per text,
  bit-exact vectors across win32-dev and linux-Lambda (recomputed canonical digests equal,
  max_abs_diff=0).
- Re-embedding legacy rows: `npm run backfill:embeddings` (CAS on revision, residual must
  be zero; run with `EMBED_PROVIDER=local-onnx`).

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
| EventBridge rule | `tidemark-nightly` | `cron(0 19 * * ? *)` (03:00 Beijing). Event time is floored to the minute into the canonical `scheduled_for`, so duplicate/retried deliveries land on the same `nightly_runs` key and commit exactly once (handler-level proof in smoke S11). |
| SQS DLQ | `tidemark-nightly-dlq` | Two failure layers, both explicit (smoke S13 asserts them): EventBridge target `RetryPolicy` + `DeadLetterConfig` for delivery failures; Lambda async event-invoke-config (2 retries, 6h age, `OnFailure` -> DLQ) for function-code failures. The nightly handler deliberately fails on nonterminal job states (lease held, retryable, stale, crashed), so async retries carry the same event = same canonical schedule = takeover of the same run; exhausted retries land in the DLQ instead of vanishing. |

The prod database (`tidemark_prod`) is migrated + verified from your machine as part of the deploy. Functions receive only `TIDEMARK_SECRET_ARN`; secrets are pulled at cold start (`src/lib/secrets.mjs`, allowlisted keys, fail-closed: with an ARN present, all four production keys must be present after the merge or the cold start fails - configuration drift never falls back to built-in dev keys).

Bedrock status (honest): `EMBED_PROVIDER=bedrock` flips the embedding path by config only, but it stays unverified until AWS allowlisting clears (P0-01/P0-04 conditional). The nightly model extraction (`DREAM_PROVIDER`) is **stub-only for now** - the Bedrock provider branch is intentionally not wired yet (P0-07 conditional) and throws rather than pretending.

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
