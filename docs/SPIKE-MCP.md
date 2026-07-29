# SPIKE-MCP：CockroachDB Cloud 真实能力验证

> 结论 19 要求的 capability spike。逐项更新，全部通过前 SPEC 的 MCP 小节保持 `pending spike`。

## 第一步：SQL driver 直连 + VECTOR 能力（2026-07-29 06:05 完成）

环境：CockroachDB Cloud serverless，v26.2.1，node-postgres (pg)，脚本 `spike/connectivity.mjs`。

| 验证项 | 结果 | 备注 |
|---|---|---|
| TLS 连接 | OK | 连接串 verify-full |
| SELECT version() | OK | CockroachDB CCL v26.2.1 |
| CREATE TABLE 含 VECTOR(4) 列 | OK | |
| CREATE VECTOR INDEX | OK | |
| INSERT 向量行（字符串字面量 `'[0.1,...]'`） | OK | |
| `<->` 距离查询 + ORDER BY dist LIMIT | OK | top1 命中，dist=0.1000 |
| 原子 UPDATE ... RETURNING | OK | 结论 23 短事务的基础操作可用 |
| DROP TABLE 清理 | OK | |

**结论：业务路径（Memory MCP → SQL driver → CRDB）技术可行性确认。**

## 第二步：Managed MCP 实测（待办，依赖 OAuth 接入）

- [ ] `tools/list` 实际清单存档（对照官方文档 12 工具）
- [ ] `select_query` 能否执行 vector distance 查询
- [ ] `insert_rows` 对 VECTOR / JSON 字段的输入形态
- [ ] 探测未文档化的 update / custom-tool 能力
- [ ] 对照比赛规则原文确认 MCP "使用" 门槛
- [ ] end-to-end 审计：按 request_id 查 recall_requests → memory → nightly provenance

## 第三步：AWS runtime spike（P0-01，2026-07-29 完成——判定：Lambda + API Gateway 成立）

环境：us-east-1，nodejs22.x，512MB，express + serverless-http，官方 MCP SDK 客户端验收。

| 验证项 | 结果 | 备注 |
|---|---|---|
| 公网真实 MCP 会话（initialize/tools/list/tools/call） | OK ×3 连跑 | 官方 StreamableHTTPClientTransport |
| 冷启动 | OK ~3-5s 首连 | 热启动 ~1.6s/会话 |
| Lambda 内连 CRDB Cloud（TLS，pool max=1） | OK | SELECT version() 一次通过 |
| 认证头透传（auth→tenant 映射的前提） | OK | /debug 实测 API GW 完整透传 headers |

**三个关键发现（实现必须遵守）：**
1. **Function URL 在新账户上被账户级限制挡死（403 Forbidden，策略正确也无效）**——弃用，走 API Gateway HTTP API（$default 路由→Lambda），一次通过
2. **serverless-http 的 mock 请求缺 `rawHeaders`**，SDK 底层 Hono 转换依赖它导致 406——handler 里必须补 `req.rawHeaders`（shim 已写在 spike/aws/handler.mjs）
3. **必须 `enableJsonResponse: true`（无状态纯 JSON 模式）**——SSE 流式响应会让 Lambda 进程崩（Runtime.NodeJsExit）；buffered 模型只能一问一答，正好符合 SPEC 的 stateless 设计

- [ ] Bedrock 模型调用权限与可用区确认（下一步）
- [ ] EventBridge Scheduler → Lambda 定时触发样例（P0-09 前完成）
