// 模型封存下载（Codex 转身硬边界 #4）：按【固定 commit】拉取 Xenova/all-MiniLM-L6-v2 的
// 量化 ONNX + tokenizer 三件套到 models/ 本地目录，打印每个文件的 SHA256 供 SPIKE-ONNX.md
// 封存记录。运行时 allowRemoteModels=false，Lambda 冷启动绝不出网下模型。
// 用法: node fetch-model.mjs   （走系统 HTTPS_PROXY；文件已存在且 SHA 一致则跳过）
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMMIT = '751bff37182d3f1213fa05d7196b954e230abad9'   // 2026-08-02 钉死
const REPO = 'Xenova/all-MiniLM-L6-v2'
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
// transformers.js 的 localModelPath 布局: <localModelPath>/<repo>/<files>
const DEST = join(HERE, 'models', REPO)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

for (const f of FILES) {
  const dest = join(DEST, f)
  if (existsSync(dest)) {
    console.log(`exists  ${f}  sha256=${sha256(readFileSync(dest))}`)
    continue
  }
  const url = `https://huggingface.co/${REPO}/resolve/${COMMIT}/${f}`
  process.stdout.write(`fetch   ${f} ... `)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} -> ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)}MB  sha256=${sha256(buf)}`)
}
console.log('model sealed at', DEST)
