// embedding provider 层：local-onnx | bedrock | stub，切换只动 EMBED_PROVIDER。
// 结论 55：v1 主路径 = local-onnx（Lambda 内自托管，模型指纹派生身份）；
// bedrock 分支保留为企业账号可选项（本账号官方终审拒绝，resolved-negative）；
// stub 仅测试（sha256 伪向量，无语义）。
// embedModelId()：当前 provider 的【落库身份串】——remember 写入、recall 过滤、
// 三处 pipeline version 都从这一个出口取值，不允许第二个来源。
import { createHash } from 'node:crypto'
import { DIMS, toF32 } from './vector-canonical.mjs'
import { embedIdentity } from './embed-identity.mjs'

const EMBED_MODEL = 'amazon.titan-embed-text-v2:0'
let bedrock

const providers = {
  'local-onnx': async (text) => {
    const { embedLocalOnnx } = await import('./embed-local-onnx.mjs')
    const r = await embedLocalOnnx(text)
    return { f32: toF32(r.vector), model_id: r.embedding_model_id, provider: 'local-onnx', truncated: r.truncated, token_count: r.token_count }
  },
  bedrock: async (text) => {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')
    bedrock ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' })
    const r = await bedrock.send(new InvokeModelCommand({
      modelId: EMBED_MODEL, contentType: 'application/json', accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: DIMS })
    }))
    return { f32: toF32(JSON.parse(new TextDecoder().decode(r.body)).embedding), model_id: EMBED_MODEL, provider: 'bedrock' }
  },
  stub: async (text) => {
    const h = createHash('sha256').update(text).digest()
    return { f32: toF32(Array.from({ length: DIMS }, (_, i) => (h[i % 32] / 255) * 2 - 1)), model_id: 'stub-sha256-512', provider: 'stub' }
  }
}

const PROVIDER = process.env.EMBED_PROVIDER || 'local-onnx'
if (!providers[PROVIDER]) throw new Error(`invalid EMBED_PROVIDER "${PROVIDER}" (expected local-onnx|bedrock|stub)`)
export const embed = providers[PROVIDER]
export const embedProviderName = PROVIDER
// 当前 provider 的落库身份（同步、模块加载即定）：local-onnx 派生完整 64-hex 身份，
// 其余用各自 model id 字面量。remember/recall/pipeline-version 的唯一取值出口。
export const embedModelId = () =>
  PROVIDER === 'local-onnx' ? embedIdentity().embedding_model_id
  : PROVIDER === 'bedrock' ? EMBED_MODEL
  : 'stub-sha256-512'
