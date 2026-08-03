// P0-09 主服务 Lambda 入口：API Gateway HTTP API (payload v2) -> serverless-http -> 同一个
// express app（src/server.mjs 导出）。本地 node src/server.mjs 与线上 Lambda 共享全部
// 路由/鉴权/幂等语义——不存在两套 server 实现。
// 引导顺序契约：工具模块在【加载时】fail-fast 校验 TIDEMARK_HMAC_KEY（P0-03 起的设计），
// 所以 server.mjs 必须在 bootstrapSecrets() 之后【动态】导入——静态 import 会先于模块体
// 求值，凭据未注入即抛错。此处顺序就是契约，改动前先想清楚这行注释。
import serverless from 'serverless-http'
import { bootstrapSecrets } from '../lib/secrets.mjs'

await bootstrapSecrets()
const { app } = await import('../server.mjs')

export const handler = serverless(app)
