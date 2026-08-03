// recall pipeline 版本串：覆盖所有影响候选语义/注入形状的参数——
// 同版本必须可解释同一召回行为（审计卖点的防伪线）。历史 receipt 保留旧版本号，不回写。
// 独立模块：测试可 import 而不触发服务端 secret 校验。
import { embedModelId } from './embed.mjs'
import { TOKEN_ESTIMATOR_VERSION } from './tokens.mjs'
import { CFG } from './recall-config.mjs'

export const PIPELINE_VERSION = [
  // v6: embed 段从 provider 名升级为精确模型身份（local-onnx = 完整 64-hex 派生串，结论 55）——
  // 同 provider 换模型/换量化/换运行时版本都会 bump，rerun 绝不复用旧 run/receipt 身份
  'recall-v6',
  `embed=${embedModelId()}`, 'dims=512',
  `rerank=${CFG.weights.sim}sim+${CFG.weights.vit}vit+${CFG.weights.util}util+${CFG.weights.imp}imp`,
  `gateA=${CFG.semantic_gate}`, `topN=${CFG.vector_top_n}`, `overfetchMax=${CFG.overfetch_max}`,
  `floorB=${CFG.second_path_floor}`, `limitB=${CFG.second_path_limit}`,
  `budget=ev${CFG.event_budget.max_items}/${CFG.event_budget.max_tokens}+ex${CFG.experience_budget.max_items}/${CFG.experience_budget.max_tokens}+total${CFG.total_token_ceiling}`,
  'inject-schema=v2-event-created-state',
  `tokens=${TOKEN_ESTIMATOR_VERSION}`,
].join('|')
