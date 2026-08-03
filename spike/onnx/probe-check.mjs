// 部署 probe 的 digest 重算核对（round-4 P2）：不信 probe 自报的 canonical digest，
// 从返回 vector 用 staging 树里那份正式 canonical 实现重算并比对。
// 用法: node probe-check.mjs <response.json> <staging-dir>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , respPath, stagingDir] = process.argv
if (!respPath || !stagingDir) throw new Error('usage: node probe-check.mjs <response.json> <staging-dir>')
const r = JSON.parse(readFileSync(respPath, 'utf8'))
const { toF32, canonicalDigest } = await import(pathToFileURL(join(stagingDir, 'vector-canonical.mjs')).href)
if (!Array.isArray(r.vectors) || r.vectors.length < 1) throw new Error('probe response carries no vectors')
const recomputed = canonicalDigest(toF32(r.vectors[0]))
if (recomputed !== r.canonical_digests[0]) {
  throw new Error(`probe digest recompute mismatch: declared ${r.canonical_digests[0]} recomputed ${recomputed}`)
}
console.log(`probe digest recomputed OK: ${recomputed.slice(0, 16)}...`)
