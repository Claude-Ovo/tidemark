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

## 第三步：AWS（待办，依赖账号/绑卡）

- [ ] Lambda + EventBridge Scheduler 定时触发最小样例
- [ ] Bedrock 模型调用权限与可用区确认
