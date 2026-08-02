// 模型封存下载（round-2 修 P1-1：manifest 驱动、真校验、原子落盘）：
// - manifest.json 是唯一真相源：文件清单与期望 SHA256 全部来自它，本脚本无内联 hash
// - 已存在文件也必须比对：mismatch（含中断残留的半文件）-> 重新下载
// - 下载先落 .part 临时文件，SHA256 比对通过后原子 rename——任何时刻最终路径上
//   要么没有文件、要么是校验过的完整文件
// - 收尾全量复验一遍并打印，供封存记录
// 用法: NODE_USE_ENV_PROXY=1 node fetch-model.mjs   （跨国线路走 HTTPS_PROXY）
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'))
const DEST = join(HERE, 'models', MANIFEST.model_repo)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const fetchVerified = async (rel, expected) => {
  const url = `https://huggingface.co/${MANIFEST.model_repo}/resolve/${MANIFEST.model_commit}/${rel}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} -> ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const actual = sha256(buf)
  if (actual !== expected) throw new Error(`SHA mismatch for ${rel}: expected ${expected}, got ${actual}`)
  const dest = join(DEST, rel)
  const tmp = `${dest}.part-${randomUUID().slice(0, 8)}`
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(tmp, buf)
  renameSync(tmp, dest)
  return buf.length
}

for (const [rel, expected] of Object.entries(MANIFEST.files)) {
  const dest = join(DEST, rel)
  if (existsSync(dest)) {
    const actual = sha256(readFileSync(dest))
    if (actual === expected) { console.log(`verified ${rel} (cached)`); continue }
    console.log(`stale    ${rel}: ${actual.slice(0, 12)}... != expected; refetching`)
    rmSync(dest, { force: true })
  }
  process.stdout.write(`fetch    ${rel} ... `)
  const bytes = await fetchVerified(rel, expected)
  console.log(`${(bytes / 1024 / 1024).toFixed(1)}MB verified`)
}

// 收尾全量复验：manifest 每一项在磁盘上都必须存在且摘要一致
for (const [rel, expected] of Object.entries(MANIFEST.files)) {
  const actual = sha256(readFileSync(join(DEST, rel)))
  if (actual !== expected) throw new Error(`post-check failed for ${rel}`)
}
console.log(`model sealed & fully verified at ${DEST} (${Object.keys(MANIFEST.files).length} files)`)
