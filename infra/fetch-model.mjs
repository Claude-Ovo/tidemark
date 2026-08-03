// 模型封存下载（主树版，真相源 = 仓库根 embed-manifest.json）：manifest 驱动、真校验、
// 原子落盘。已存在文件也必须比对；下载落 .part 临时文件、SHA 过了才 rename；收尾全量复验。
// 用法: NODE_USE_ENV_PROXY=1 node infra/fetch-model.mjs
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'embed-manifest.json'), 'utf8'))
const DEST = join(ROOT, 'models', MANIFEST.model_repo)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

for (const [rel, expected] of Object.entries(MANIFEST.files)) {
  const dest = join(DEST, rel)
  if (existsSync(dest)) {
    const actual = sha256(readFileSync(dest))
    if (actual === expected) { console.log(`verified ${rel} (cached)`); continue }
    console.log(`stale    ${rel}; refetching`)
    rmSync(dest, { force: true })
  }
  const url = `https://huggingface.co/${MANIFEST.model_repo}/resolve/${MANIFEST.model_commit}/${rel}`
  process.stdout.write(`fetch    ${rel} ... `)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} -> ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const actual = sha256(buf)
  if (actual !== expected) throw new Error(`SHA mismatch for ${rel}: expected ${expected}, got ${actual}`)
  const tmp = `${dest}.part-${randomUUID().slice(0, 8)}`
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(tmp, buf)
  renameSync(tmp, dest)
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)}MB verified`)
}
for (const [rel, expected] of Object.entries(MANIFEST.files)) {
  if (sha256(readFileSync(join(DEST, rel))) !== expected) throw new Error(`post-check failed for ${rel}`)
}
console.log(`model sealed & fully verified at ${DEST}`)
