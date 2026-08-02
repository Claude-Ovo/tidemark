# Third-party model attribution

- Embedding model: **all-MiniLM-L6-v2** by the sentence-transformers team
  (https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), License: Apache-2.0.
- ONNX conversion/quantization: **Xenova/all-MiniLM-L6-v2**
  (https://huggingface.co/Xenova/all-MiniLM-L6-v2), pinned at commit
  `751bff37182d3f1213fa05d7196b954e230abad9`; file SHA256 digests are frozen in `manifest.json`.
- Runtime: **@huggingface/transformers** 4.2.0 (Apache-2.0), **onnxruntime** (MIT).

The model artifacts are NOT committed to this repository; `fetch-model.mjs` downloads them
from the pinned commit and verifies every file against `manifest.json` before use. The Lambda
runtime re-verifies the same digests at cold start and fails closed on any mismatch.
