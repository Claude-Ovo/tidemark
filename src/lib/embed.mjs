// embedding provider 层（P0-01 已验证的模式）：bedrock | stub，切换只动 EMBED_PROVIDER
import { createHash } from 'node:crypto'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { DIMS, toF32 } from './vector-canonical.mjs'

const EMBED_MODEL = 'amazon.titan-embed-text-v2:0'
let bedrock

const providers = {
  bedrock: async (text) => {
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

const PROVIDER = process.env.EMBED_PROVIDER || 'bedrock'
if (!providers[PROVIDER]) throw new Error(`invalid EMBED_PROVIDER "${PROVIDER}" (expected bedrock|stub)`)
export const embed = providers[PROVIDER]
export const embedProviderName = PROVIDER
