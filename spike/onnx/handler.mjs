// packaging/runtime spike handler（round-2：manifest 为部署身份唯一真相源）：
// - 冷启动先按 manifest.json 逐文件验 SHA256——缺文件/摘要错直接抛，绝不带残缺模型服务
// - digest 用正式 canonical 算法（toF32 + sha256 over LE bytes，完整 512 维 64-hex），
//   不再有"前 16 维 JSON 文本"的抽样变体
// - pipeline 单例 Promise；allowRemoteModels=false + localModelPath，冷启动零出网
// - event.return_vectors=true 时附全量向量，供对端计算 max_abs_diff（跨平台一致性证据）
import { pipeline, env } from '@huggingface/transformers'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toF32, canonicalDigest } from './vector-canonical.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'))

// fail-closed 模型完整性闸：manifest 每一项都必须在场且摘要一致
const verifyModelArtifacts = () => {
  const base = join(HERE, 'models', MANIFEST.model_repo)
  for (const [rel, expected] of Object.entries(MANIFEST.files)) {
    let buf
    try { buf = readFileSync(join(base, rel)) }
    catch { throw new Error(`model artifact missing: ${rel} (fail-closed)`) }
    const actual = createHash('sha256').update(buf).digest('hex')
    if (actual !== expected) throw new Error(`model artifact SHA mismatch: ${rel} expected ${expected} got ${actual}`)
  }
}

env.allowRemoteModels = false
env.localModelPath = join(HERE, 'models')

let loadMs = null
const t0 = Date.now()
verifyModelArtifacts()
const extractorP = pipeline('feature-extraction', MANIFEST.model_repo, { dtype: MANIFEST.output.dtype })
  .then((p) => { loadMs = Date.now() - t0; return p })

const embed512 = async (text) => {
  const extractor = await extractorP
  const out = await extractor(text, { pooling: MANIFEST.output.pooling, normalize: MANIFEST.output.normalize })
  const v = Array.from(out.data)
  if (v.length !== MANIFEST.output.native_dims) throw new Error(`expected ${MANIFEST.output.native_dims} dims, got ${v.length}`)
  return [...v, ...new Array(MANIFEST.output.pad_to - MANIFEST.output.native_dims).fill(0)]
}

export const handler = async (event) => {
  const texts = event?.texts ?? ['the tide leaves a mark on the shore']
  const timings = [], vectors = [], digests = []
  for (const t of texts) {
    const s = Date.now()
    const v = await embed512(t)
    timings.push(Date.now() - s)
    vectors.push(v)
    digests.push(canonicalDigest(toF32(v)))   // 完整 512 维、正式算法、64-hex
  }
  const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
  const semantic = vectors.length >= 3
    ? { paraphrase: cos(vectors[0], vectors[1]), unrelated: cos(vectors[0], vectors[2]) }
    : null
  return {
    embedding_model_id: MANIFEST.embedding_model_id,
    inputs: texts, dims: vectors[0].length, load_ms: loadMs, infer_ms: timings,
    semantic, canonical_digests: digests,
    ...(event?.return_vectors ? { vectors } : {}),
    node: process.version, memory_mb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? 0),
  }
}
