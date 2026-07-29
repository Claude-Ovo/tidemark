# P0-01 端到端证据（stub run，2026-07-29）

同一 `request_id` 贯穿三处，无正文无密钥：

**1. 客户端断言输出**（`node client-test.mjs <url> stub`，exit 0）
```
PASS 1 unauthorized probe rejected with isError
PASS 2 end-to-end auth->stub->crdb + digest verified (1762ms) request_id=8ea514a3-6373-41cf-ad21-fa2c75386f2b
PASS 3 cross-agent isolation enforced
PASS 4 error path does not poison warm container
PASS 5 concurrency under pool max=1: 4/4 ok (1975ms total)
ALL SPIKE ASSERTIONS PASSED (provider=stub)
```

**2. CloudWatch 结构化日志**（/aws/lambda/tidemark-spike，Lambda invoke 6630e3f4）
```
{"evt":"probe_memory","request_id":"8ea514a3-6373-41cf-ad21-fa2c75386f2b","tenant_id":"demo-tenant","agent_id":"demo-agent","provider":"stub","dims":512}
```

**3. CRDB 行**（probe_lookup 经 agent-scoped 查询回读，断言通过）
- PK：(demo-tenant, demo-agent, 8ea514a3-...)
- `embedding VECTOR(512)` 实际值入库，读回后按 canonical 算法（4 位定点 sha256）重算 digest 与写入前 digest 一致（digest_match=true）
- 越权验证：second-agent 持同一 request_id 查询 → not_found_in_scope

**待补（Bedrock allowlisting 批准后 24h 内）**：同套件以 `expected_provider=bedrock` 重跑，断言 model_id=amazon.titan-embed-text-v2:0，三处证据重新采集。

复现：`spike/aws/deploy.ps1`（migrate + 打包 + 无 BOM cli-input-json 下发 env + wait），再跑 client-test。
