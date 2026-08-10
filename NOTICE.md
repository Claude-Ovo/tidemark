# Third-party model attribution

- Embedding model: **all-MiniLM-L6-v2** by the sentence-transformers team
  (https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), License: Apache-2.0.
- ONNX conversion/quantization: **Xenova/all-MiniLM-L6-v2**
  (https://huggingface.co/Xenova/all-MiniLM-L6-v2), pinned at commit
  `751bff37182d3f1213fa05d7196b954e230abad9`; file SHA256 digests are frozen in
  `embed-manifest.json` (repo root).
- Runtime: **@huggingface/transformers** 4.2.0 (Apache-2.0), **onnxruntime** (MIT).
  Note: the derived `embedding_model_id` covers the *installed* runtime version — the
  identity mechanism detects version drift and refuses cross-space mixing by design.

The model artifacts are NOT committed to this repository; `infra/fetch-model.mjs` downloads
them from the pinned commit and verifies every file against `embed-manifest.json` before use.
The Lambda runtime re-verifies the same digests at cold start and fails closed on any mismatch.
