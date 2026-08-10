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

## 第三步：AWS runtime spike（P0-01——〔2026-08-10 状态更新〕本地闭环+生产部署已签
##（README §Deploy、prod smoke 13/13）；原 Bedrock blocker 已 **resolved-negative**
##（结论 55：官方终审拒绝，embedding 转 Lambda 内 local-onnx 并在生产验真，
## 证据见 SPIKE-ONNX.md），下方"未验证"节按此读作历史记录）

环境：us-east-1，nodejs22.x，512MB，express + serverless-http，官方 MCP SDK 客户端 + 断言套件验收（`spike/aws/client-test.mjs`，退出码生效）。证据链见 `SPIKE-EVIDENCE.md`。

### 已验证（stub provider run，五场景断言全过）

| 验证项 | 结果 |
|---|---|
| 公网真实 MCP 会话（initialize/tools/list/tools/call） | OK（官方 client，warm ~1.6s，冷启动首连 3-5s） |
| 端到端单请求链：auth header→tenant/agent 映射→embed→CRDB `VECTOR(512)` 落行→digest 回验 | OK（digest_match，DB 内实际向量核验，非元数据） |
| 无 auth 调用以 MCP `isError` 拒绝 | OK |
| agent-scoped 隔离（同 tenant 第二 principal 持 request_id 越权查询被拒） | OK |
| 未知 tool 报错后 warm 容器不被毒化 | OK |
| 4 concurrent invocations succeed（多执行环境扩容，6 个 log stream 为证；非单池排队） | OK |
| 冷启动后 DB 重连（3×INIT_START 后测试全过） | OK |
| CloudWatch 结构化日志与 CRDB 行按 request_id 对应 | OK |

### 未验证（历史 blocker——已 resolved-negative 终局）

- **Bedrock 段**〔2026-08-03 终局，结论 55〕：工单终审**拒绝**（enterprise-only），
  非待批。原"批准后 24h 重跑"条件永久不可满足，作废；P0-01 的完成判据改由
  local-onnx 主路径承担（六条硬边界另行验收，已签——SPIKE-ONNX.md + 生产 smoke）。
  `EMBED_PROVIDER=bedrock` 分支保留为企业账号可选未验证路径。

### 三个关键发现（实现必须遵守）

1. **Function URL 在本（新）账户实测 403（策略正确亦然）**——本项目定型 API Gateway HTTP API（$default→Lambda）
2. **serverless-http 的 mock 请求缺 `rawHeaders`**，SDK 底层 Hono 转换依赖它导致 406——必须补 shim（见 handler.mjs）
3. **当前 `serverless-http + API Gateway HTTP API buffered integration` 组合实测 SSE 不可用**（进程 Runtime.NodeJsExit），故 v1 固定 `enableJsonResponse: true` 无状态纯 JSON——与 SPEC stateless 设计一致。注：这是本栈组合的边界，非 AWS 平台能力上限——官方支持见 [Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html) 与 [API Gateway response transfer mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)，本项目不采用
4. **并发活跃业务连接预算**：新账户 Lambda 总并发=10 且不可配 per-function reserved concurrency（实测被拒）；预算=账户并发(10)×pool.max(1)，idle/redeploy/admin socket 另计、留 headroom；限额提升后改用 reserved concurrency 收紧
5. **本项目 PS5.1 兼容策略：.ps1 一律 ASCII-only 注释**（Windows PowerShell 5.1 将无 BOM 脚本按 ANSI 解码，非 ASCII 字节会破坏解析——带 BOM 或 PowerShell 7 无此问题，故为项目策略而非技术必然）

- [x] EventBridge Scheduler → Lambda 定时触发（P0-09 已交付签收：cron 规则 + canonical
  scheduled_for + DLQ 双层失败通路，生产 smoke S11/S13 断言，见 README 部署表）
