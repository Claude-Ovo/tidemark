// packaging/runtime spike handler（Codex 转身硬边界先行项）：证明 Linux x64 的
// onnxruntime-node + 量化 MiniLM 能在 Lambda 里冷启动加载并出真语义向量。
// - 模型只认本地封存（allowRemoteModels=false + localModelPath），缺文件直接 fail-closed
// - pipeline 是 module 单例 Promise：并发 invoke 共享一次加载
// - 输出 384 维 mean-pooled + L2 normalized，再零填充到 512（cosine 精确保持）
// - 返回计时与向量指纹，供 SPIKE-ONNX.md 封存证据
import { pipeline, env } from '@huggingface/transformers'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

env.allowRemoteModels = false
env.localModelPath = join(dirname(fileURLToPath(import.meta.url)), 'models')

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
let loadMs = null
const t0 = Date.now()
const extractorP = pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
  .then((p) => { loadMs = Date.now() - t0; return p })

const embed512 = async (text) => {
  const extractor = await extractorP
  const out = await extractor(text, { pooling: 'mean', normalize: true })
  const v384 = Array.from(out.data)
  if (v384.length !== 384) throw new Error(`expected 384 dims, got ${v384.length}`)
  return [...v384, ...new Array(128).fill(0)]
}

export const handler = async (event) => {
  const texts = event?.texts ?? ['the tide leaves a mark on the shore']
  const timings = []
  const vectors = []
  for (const t of texts) {
    const s = Date.now()
    vectors.push(await embed512(t))
    timings.push(Date.now() - s)
  }
  // 语义 sanity（真向量 vs 哈希向量的分水岭）：paraphrase 必须比 unrelated 更近
  const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
  let semantic = null
  if (vectors.length >= 3) {
    semantic = { paraphrase: cos(vectors[0], vectors[1]), unrelated: cos(vectors[0], vectors[2]) }
  }
  return {
    model: MODEL_ID, dims: vectors[0].length, load_ms: loadMs, infer_ms: timings,
    semantic, vec_digest: createHash('sha256').update(JSON.stringify(vectors[0].slice(0, 16))).digest('hex').slice(0, 16),
    node: process.version, memory_mb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? 0),
  }
}
