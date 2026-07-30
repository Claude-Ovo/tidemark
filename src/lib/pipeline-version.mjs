// recall pipeline 版本串：覆盖所有影响候选语义/注入形状的参数——
// 同版本必须可解释同一召回行为（审计卖点的防伪线）。历史 receipt 保留旧版本号，不回写。
// 独立模块：测试可 import 而不触发服务端 secret 校验。
import { embedProviderName } from './embed.mjs'
import { TOKEN_ESTIMATOR_VERSION } from './tokens.mjs'
import { CFG } from './recall-config.mjs'

export const PIPELINE_VERSION = [
  'recall-v3',
  `embed=${embedProviderName}`, 'dims=512',
  `rerank=${CFG.weights.sim}sim+${CFG.weights.vit}vit+${CFG.weights.util}util+${CFG.weights.imp}imp`,
  `gateA=${CFG.semantic_gate}`, `topN=${CFG.vector_top_n}`, `overfetchMax=${CFG.overfetch_max}`,
  `floorB=${CFG.second_path_floor}`, `limitB=${CFG.second_path_limit}`,
  `budget=ev${CFG.event_budget.max_items}/${CFG.event_budget.max_tokens}+ex${CFG.experience_budget.max_items}/${CFG.experience_budget.max_tokens}+total${CFG.total_token_ceiling}`,
  'inject-schema=v2-event-created-state',
  `tokens=${TOKEN_ESTIMATOR_VERSION}`,
].join('|')
