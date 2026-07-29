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
#    Production deployments MUST use a real secret (Secrets Manager planned in P0-09).

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

## License

MIT (license file added before submission).
