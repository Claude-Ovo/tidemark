# Third-party notices

Tidemark is released under the MIT License (see `LICENSE`). This file lists the
third-party components it depends on, their licenses, and how they are used.
Verified 2026-08-12 against `package.json` / `web/package.json` and the published
license of each project.

## Runtime dependencies (server / agent path)

| Component | License | Role |
|---|---|---|
| `@modelcontextprotocol/sdk` | MIT | MCP server transport for the five agent-facing tools |
| `pg` | MIT | CockroachDB (PostgreSQL wire protocol) client |
| `express` | MIT | HTTP routing for the MCP endpoint and read-only viz endpoints |
| `serverless-http` | MIT | Adapts the Express app to the AWS Lambda handler |
| `zod` | MIT | Tool input validation / schema enforcement |
| `dotenv` | MIT | Local development environment loading (never used for production secrets) |
| `@aws-sdk/client-secrets-manager` | Apache-2.0 | Reads the single production secret at cold start |
| `@aws-sdk/client-bedrock-runtime` | Apache-2.0 | Present for the unverified enterprise-account provider branch only; not on the request path (see README, Bedrock status) |
| `@huggingface/transformers` | Apache-2.0 | In-Lambda ONNX inference runtime for embeddings |
| `onnxruntime-node` / `onnxruntime-web` (transitive) | MIT | Executes the sealed embedding model |

## Frontend dependencies (visualization)

| Component | License | Role |
|---|---|---|
| `three` | MIT | WebGL renderer for the 3D memory tide pool |
| `react`, `react-dom` | MIT | Shell application (the pool page itself is dependency-free vanilla JS) |
| `gsap`, `@gsap/react` | GreenSock standard "no charge" license | Present in the shell app dependency set; the submitted pool visualization does not import it |
| `vite`, `@vitejs/plugin-react`, `typescript`, `@types/*` | MIT / Apache-2.0 | Build tooling only, not shipped at runtime |

## Model artifacts

The embedding model (`all-MiniLM-L6-v2`, Apache-2.0; ONNX conversion by
`Xenova/all-MiniLM-L6-v2`) is **not** committed to this repository. It is fetched
from a pinned commit and SHA256-verified at build and cold start. Full attribution
and digest policy: `NOTICE.md`.

## Visual references and originality

The 3D water, rain, height field, impact and shading code in
`web/src/pool/three/` is original to this repository.

External sites and screenshots (including https://rainform.pages.dev/, licensed
PolyForm Noncommercial 1.0.0) were used **only** as visual mood references by the
project owner. No third-party source code, shader, bundle, asset, texture, audio,
UI copy, constant, name or logo was copied, transcribed, translated or adapted,
and no PolyForm-licensed code is present in this repository or its lockfiles. A
provenance scan over the repository and lockfiles (2026-08-12) for
`rainform` / `afterimage` / `polyform` / `noncommercial` returns only this
project's own originality statements.
