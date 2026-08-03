# local-onnx packaging/runtime spike（2026-08-02，round-2 证据链闭环版）

## 判定：可行。零外部依赖的真语义 embedding 在现有 Lambda 形态内成立。

## 单一真相源：`spike/onnx/manifest.json`

模型仓库/commit、四件套 SHA256、license、输出契约（384 mean+L2 -> pad 512）、
全部只写在 manifest；fetch 脚本按它下载校验，**Lambda 冷启动按它逐文件复验（mismatch/缺文件直接拒启，
fail-closed）**。`embedding_model_id` **不是手写串而是派生值**（`identity.mjs`）：
可读前缀 + canonical digest，digest 覆盖 full commit、四件套 SHA、dtype/pooling/normalize/dims 与
transformers/onnxruntime **实际安装版本**（与 manifest 对账，漂移即抛）——任何影响向量空间的
字段变化都会改变身份。**DB/pipeline 使用完整 64-hex digest**（短摘要只作展示，禁止落库——
碰撞即隔离失效且无碰撞检测），当前值
`Xenova/all-MiniLM-L6-v2@751bff37:q8:mean:l2:pad512#4e395029068132b0a48935d3fb5a1cdb1e1a73712188c80790aa4b55c37edb08`，
staging 推导、Lambda 冷启动、本地三处一致。
attribution 见 `spike/onnx/NOTICE.md`（Apache-2.0）。

## 可复现构建（全部入库，reviewer 可独立重建）

- `spike/onnx/fetch-model.mjs`：manifest 驱动；已存在文件也必须比对 SHA；下载落 `.part` 临时文件、
  校验通过才原子 rename；收尾全量复验。中断残留的半文件永远进不了最终路径。
- `spike/onnx/build.ps1`：`npm ci`（lockfile 已入库）-> `--force` 补 sharp linux 包（EBADPLATFORM 绕行，
  **force 会整树重装故裁剪必须在后**）-> 裁剪（onnxruntime-node 只留 napi-v6/linux/x64；删
  onnxruntime-web；删 transformers 浏览器构建与 ort-wasm*；sharp 整包替换为入库的 loud-failure 存根
  `spike/onnx/sharp-stub/`）-> 复制 handler + **正式 vector-canonical 实现（非变体）** + manifest + 模型
  -> **内容自检门**（win32/darwin/onnxruntime-web 残留即失败、sharp 必须含 TIDEMARK_SHARP_STUB 标记）
  -> zip -> 产出 `artifact-manifest.json`（模型四件套、npm lock SHA、平台、裁剪规则、zip SHA256/尺寸）
  -> `-Deploy` 时 S3 上传同一 zip、部署、**冷启动实调验收**（dims=512 才算过）。
- `spike/onnx/verify.mjs`：本地与 Lambda 对同一组文本比较**完整 512 维 canonical digest（64-hex）**
  并计算 `max_abs_diff`；**双方 digest 均从返回 vectors 重算**（自报值只用于对账，
  "旧 digest 配新向量"在对账处直接爆），bit-exact 要求重算 digest 全等【且】max_abs_diff===0；
  结构非法或任一条件不满足**以非零退出**（可作 CI 验收门）。两个反例由 `test-verify.mjs`
  断言"检出必红"：A 扰动向量+诚实重算 digest、B 扰动向量+声明 digest 保持旧值。
- 部署验真：build 以 Lambda `CodeSha256` 对本地 zip SHA256（base64）**精确对表**，再冷启动实调
  断言 dims=512 + **exact 派生身份**，且 probe 的 digest 由 `probe-check.mjs` 从返回向量
  **重算核对**（部署验收同样不信自报）——证明线上跑的就是这一个 zip。

## 实测数字（Lambda nodejs22.x / x86_64 / 1024MB / us-east-1）

| 指标 | 值 |
|---|---|
| 冷启动模型加载 | 1040-1099ms（含 manifest SHA 复验） |
| 冷启动首推理 | 约 1.1s（合计约 2.2s，30s API 预算内） |
| warm 推理 | 4-34ms/条 |
| zip | 32.3MB，sha256 见 artifact-manifest（50MB 直传线内；实走 S3——直传 41MB 曾被跨国线路掐断） |
| 解压 | 70.7MB（已含 22.6MB 模型；250MB 上限的三成） |
| 语义分辨 | paraphrase cos 0.4615 vs unrelated cos -0.0028 |

## 跨平台确定性（round-2 起为完整证据，非抽样）

`verify.mjs` 输出：三条文本的**完整 512 维 canonical digest 在 win32/node24 本地与
linux/node22 Lambda 上逐条全等，max_abs_diff = 0**。

```
text0: digest EQUAL (a66a8bf98c2084e3 ...), max_abs_diff=0
text1: digest EQUAL (bbf136dee7a9db36 ...), max_abs_diff=0
text2: digest EQUAL (48a5101a22c7a4ee ...), max_abs_diff=0
```

量化 int8 ONNX + CPU EP 在两平台产出 bit 级一致向量：dev 机可离线预演生产向量与 receipt checksum。

## 复现

```
cd spike/onnx
NODE_USE_ENV_PROXY=1 node fetch-model.mjs        # 封存并校验模型（跨国线路走代理）
npm install --include=optional                    # 本地(win)功能依赖
powershell -File build.ps1 -Deploy                # 重建->自检->部署->冷启动验收（bucket/函数名可参数化）
node verify.mjs                                   # 跨平台完整 digest 对比
```
