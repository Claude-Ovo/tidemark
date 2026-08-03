// local-onnx embedding 实现（结论 55 主路径）：Lambda/本地进程内自托管推理，零外部调用。
// - 模型完整性：首次使用前按 embed-manifest.json 逐文件验 SHA256（缺/错即抛，fail-closed）
// - 单例：pipeline 是 module 级 Promise，并发共享一次加载
// - 零出网：allowRemoteModels=false + localModelPath=<repo>/models（TIDEMARK_MODEL_DIR 可覆盖，测试用）
// - 推理路径 = transformers.js FeatureExtractionPipeline（mean pooling + L2 normalize），
//   与 spike 完全同源——等价性由 test-embed-onnx 的 spike digest 锚点钉死。不手写池化：
//   浮点累加精度次序不同就会破坏跨平台 bit 级一致性（实测教训）。
// - 截断契约（六条边界 #5，按实际口径）：pipeline 内部 tokenize 固定 truncation=true，
//   机械截断界 = tokenizer.model_max_length（本模型 512；256 是训练质量长度，见 README）。
//   截断【确定性】由 pipeline 保证，【可观测】由本层外挂：全文 token 计数超界即返回
//   truncated=true + token_count 并打印结构化日志——绝不静默把前 512 token 冒充全文。
// - 输出 384 维后零填充 512（cosine/L2 精确保持，VECTOR(512) schema 不动）
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { embedIdentity } from './embed-identity.mjs'

let loaded = null
const load = async () => {
  const { manifest, repo_root, embedding_model_id } = embedIdentity()
  const modelDir = process.env.TIDEMARK_MODEL_DIR || join(repo_root, 'models')
  const base = join(modelDir, manifest.model_repo)
  for (const [rel, expected] of Object.entries(manifest.files)) {
    let buf
    try { buf = readFileSync(join(base, rel)) }
    catch { throw new Error(`model artifact missing: ${rel} (fail-closed; run infra/fetch-model.mjs)`) }
    const actual = createHash('sha256').update(buf).digest('hex')
    if (actual !== expected) throw new Error(`model artifact SHA mismatch: ${rel} expected ${expected} got ${actual}`)
  }
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowRemoteModels = false
  env.localModelPath = modelDir
  const extractor = await pipeline('feature-extraction', manifest.model_repo, { dtype: manifest.output.dtype })
  const maxTokens = extractor.tokenizer.model_max_length
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error(`tokenizer has no sane model_max_length (${maxTokens})`)
  return { extractor, manifest, embedding_model_id, maxTokens }
}

export const embedLocalOnnx = async (text) => {
  loaded ??= load()
  const { extractor, manifest, embedding_model_id, maxTokens } = await loaded
  // 可观测截断：全文 token 计数（只走 tokenizer）；机械截断由 pipeline 内部完成
  const tokenCount = extractor.tokenizer.encode(text).length
  const truncated = tokenCount > maxTokens
  if (truncated) {
    console.log(JSON.stringify({ evt: 'embed_truncated', token_count: tokenCount, max_tokens: maxTokens, chars: text.length }))
  }
  const out = await extractor(text, { pooling: manifest.output.pooling, normalize: manifest.output.normalize })
  const v = Array.from(out.data)
  if (v.length !== manifest.output.native_dims) throw new Error(`expected ${manifest.output.native_dims} dims, got ${v.length}`)
  const padded = [...v, ...new Array(manifest.output.pad_to - manifest.output.native_dims).fill(0)]
  return { vector: padded, embedding_model_id, truncated, token_count: tokenCount }
}
