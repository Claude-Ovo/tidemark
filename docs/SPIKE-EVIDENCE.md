# P0-01 端到端证据（stub run，2026-07-29，第三轮返工后）

## 最新一轮（digest float32 修复 + 全 ASCII 部署脚本后）

- 断言输出：五场景 ALL PASS，`PASS 2 ... digest verified (1346ms) request_id=ffdf3b8f-4ab4-4515-9d11-f055851d8833`
- digest 回归：`digest-test.mjs` 三组全过（含 Codex 反例值 0.678750162244703 的模拟 roundtrip）
- **冷启动证据**：部署替换代码后环境全回收，CloudWatch 记录 3 条 `INIT_START`（nodejs:22.v91），随后测试全过 = 冷启动后 DB 重连成立
- **并发/扩容证据**：并发场景窗口内出现 **6 个不同 log stream**（多执行环境各持一份 pool）——确认 Lambda 并发=多环境扩容而非单池排队；连接上界 = 账户并发上限(10) × pool.max(1)（新账户不可配置 per-function reserved concurrency：预留任意值会使 unreserved 低于最低值 10，实测被拒；限额提升后再启用，见 deploy.ps1 注释）
- **工程附加发现**：PS5.1 将无 BOM 脚本按 ANSI/GBK 解码，非 ASCII 注释字节会随机破坏解析器（本轮"提取空值/JSON 无效/括号错误"三个灵异现象同一根因）——仓库 .ps1 一律 ASCII-only 注释

## 首轮记录（历史，digest 算法当时尚有 float32 缺陷）

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

**〔2026-08-10 状态注〕原"待补（Bedrock 批准后重跑）"作废**——结论 55：Bedrock 申请
终审拒绝（resolved-negative，非待批）。生产 embedding 证据由 local-onnx 主路径承担：
见 `SPIKE-ONNX.md`（bit-exact 跨平台向量、派生身份、封存 manifest）与 `infra/smoke.mjs`
生产断言。本文其余 stub-run 证据作为 P0-01 运行时形态的历史记录保留。

复现：`spike/aws/deploy.ps1`（migrate + 打包 + 无 BOM cli-input-json 下发 env + wait + 每步退出码断言），再跑 `node client-test.mjs <url> stub` 与 `node digest-test.mjs`（固定 seed 20260729）。
**从旧 schema（commit a4bee54 一代表）升级**：必须 `.\deploy.ps1 -ResetSpikeTable`——会销毁此前 spike 证据行（本轮实际执行过 reset，旧行已弃）；migrate 会校验 schema 形态，旧表存在而未 reset 时显式失败并提示，不静默放过。
连接措辞：账户并发(10)×pool.max(1) 是**并发活跃业务连接预算**，idle/redeploy/admin socket 另计，留 headroom。
