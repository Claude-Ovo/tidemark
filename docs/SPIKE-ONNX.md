# local-onnx packaging/runtime spike（2026-08-02，Codex 转身硬边界先行项）

## 判定：可行。零外部依赖的真语义 embedding 在现有 Lambda 形态内成立。

## 封存身份（不可变）

- 模型：`Xenova/all-MiniLM-L6-v2` @ commit `751bff37182d3f1213fa05d7196b954e230abad9`，`onnx/model_quantized.onnx`（q8, 21.9MB）
  - sha256 `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`
  - config.json `7135149f…`、tokenizer.json `da0e7993…`、tokenizer_config.json `9261e7d7…`（完整值见 spike/onnx/fetch-model.mjs 输出）
  - License: Apache-2.0（原模型 sentence-transformers/all-MiniLM-L6-v2）
- 运行时：`@huggingface/transformers@4.2.0`（onnxruntime-node 1.x，CPU EP）
- 输出：384 维 mean pooling + L2 normalize，零填充至 512（cosine/L2 精确保持，`VECTOR(512)` 不动）

## 实测数字（Lambda nodejs22.x / x86_64 / 1024MB / us-east-1）

| 指标 | 值 |
|---|---|
| 冷启动模型加载 | 1099ms |
| 冷启动首推理（session warmup） | 1085ms（合计约 2.2s，30s API 预算内） |
| warm 推理 | 4-34ms/条 |
| zip | 33MB（50MB 直传线内；实际走 S3 上传，直传 41MB 时曾被跨国线路掐断） |
| 解压 | 约 76MB + 模型 23MB（250MB 上限的四成） |
| 语义分辨 | paraphrase cos 0.4615 vs unrelated cos -0.0028 |
| 确定性 | vec_digest `682651786212ddfd` —— Windows 本地(node v24)与 Lambda linux(node v22)完全一致 |

跨平台向量确定性是意外收获：同一文本在 dev 机和生产得到 bit 级一致向量，receipt 的 checksum 叙事直接受益。

## 打包配方（infra 实装时脚本化）

1. Linux staging：`npm ci` 后 `npm install --force --no-save @img/sharp-linux-x64 @img/sharp-libvips-linux-x64`（--force 绕 EBADPLATFORM；顺序必须 force 在前、裁剪在后——force 会整树重装）
2. 裁剪：onnxruntime-node/bin 只留 `napi-v6/linux/x64`（211MB->35MB）；删 onnxruntime-web（130MB，node 构建不引用）；删 transformers dist 的浏览器构建与 ort-wasm*
3. **sharp 整体存根**：transformers v4 把 sharp 设为硬依赖但仅图像管线使用；真实 linux 二进制在 Lambda 上版本错配崩载（utility.js:27）。文本专用构建用 Proxy 存根替换整包——任何真实调用大声失败，加载路径零障碍，再省 20MB
4. 模型三件套按固定 commit 下载封存进包（fetch-model.mjs 校验 sha256）；运行时 `env.allowRemoteModels=false` + `localModelPath`，冷启动零出网
5. 部署走 S3 code upload（bucket `tidemark-artifacts-875699231234`）

## 复现

```
cd spike/onnx && node fetch-model.mjs        # 封存模型（走代理）
npm install --include=optional && node -e "..."   # 本地功能验证
# Linux 产物: 见上配方；spike Lambda: tidemark-embed-spike（invoke 证据见本文数字）
```
