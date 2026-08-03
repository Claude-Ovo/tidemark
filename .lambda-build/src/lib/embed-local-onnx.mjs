// local-onnx embedding 实现（结论 55 主路径）：Lambda/本地进程内自托管推理，零外部调用。
// - 模型完整性：首次使用前按 embed-manifest.json 逐文件验 SHA256（缺/错即抛，fail-closed）
// - 单例：pipeline 是 module 级 Promise，并发共享一次加载
// - 零出网：allowRemoteModels=false + localModelPath=<repo>/models（TIDEMARK_MODEL_DIR 可覆盖，测试用）
// - 推理路径 = transformers.js FeatureExtractionPipeline（mean pooling + L2 normalize），
//   与 spike 完全同源——等价性由 test-embed-onnx 的 spike digest 锚点钉死。不手写池化：
//   浮点累加精度次序不同就会破坏跨平台 bit 级一致性（实测教训）。
// - 截断契约（六条边界 #5 冻结值，round-2 P1-3 纠偏）：max_tokens=**256**（模型训练长度）
//   由 manifest.output 冻结并进入派生身份——不是 tokenizer 的 512 机械上限。
//   实现 = head-token-decode 预截断：全文 tokenize -> 超界则取前 max_tokens 个 token id
//   decode 回文本 -> 送 pipeline（pipeline 路径保持与 spike 同源，短文本零改动）。
//   确定性：同前缀 token 序列 -> 同 decode 文本 -> 同向量（E5b 以"前 256 token 相同、
//   尾部不同"的双文本断言向量全等）。可观测：truncated/token_count + 结构化日志，
//   绝不静默把前 256 token 冒充全文。
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
  const maxTokens = manifest.output.max_tokens   // 冻结的策略值（进身份），非 tokenizer 机械上限
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error(`manifest output.max_tokens invalid (${maxTokens})`)
  if (manifest.output.truncation !== 'head-token-decode') throw new Error(`unknown truncation policy ${manifest.output.truncation}`)
  return { extractor, manifest, embedding_model_id, maxTokens }
}

export const embedLocalOnnx = async (text) => {
  loaded ??= load()
  const { extractor, manifest, embedding_model_id, maxTokens } = await loaded
  // 冻结截断策略 head-token-decode：全文计数可观测；超界取前 max_tokens 个 token id
  // decode 回文本再走 pipeline——短文本（绝大多数记忆）与 spike 路径逐字节同源
  const fullIds = extractor.tokenizer.encode(text)
  const tokenCount = fullIds.length
  const truncated = tokenCount > maxTokens
  let input = text
  if (truncated) {
    input = extractor.tokenizer.decode(fullIds.slice(0, maxTokens), { skip_special_tokens: true })
    console.log(JSON.stringify({ evt: 'embed_truncated', token_count: tokenCount, max_tokens: maxTokens, chars: text.length }))
  }
  const out = await extractor(input, { pooling: manifest.output.pooling, normalize: manifest.output.normalize })
  const v = Array.from(out.data)
  if (v.length !== manifest.output.native_dims) throw new Error(`expected ${manifest.output.native_dims} dims, got ${v.length}`)
  const padded = [...v, ...new Array(manifest.output.pad_to - manifest.output.native_dims).fill(0)]
  return { vector: padded, embedding_model_id, truncated, token_count: tokenCount }
}
