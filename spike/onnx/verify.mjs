// 跨平台一致性验收（round-2 修 P1-2）：本地(win)与 Lambda(linux) 对同一组文本
// 比较【完整 512 维 canonical digest（正式算法 64-hex）】并计算 max_abs_diff。
// 全等 -> "bit 级一致"的结论才成立；不等 -> 打印逐文本差异，结论降级为数值近似。
// 用法: node verify.mjs [function-name]   （需本地 aws cli 凭据；走 HTTPS_PROXY 时
//        以 NODE_USE_ENV_PROXY=1 运行不影响——Lambda 调用走 aws.exe 自身代理）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FN = process.argv[2] ?? 'tidemark-embed-spike'
const AWS_CLI = process.env.AWS_CLI_PATH || 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
const TEXTS = [
  'the deployment failed because the API key was invalid',
  'authentication credentials were wrong so the release did not go through',
  'my cat enjoys sleeping on the warm windowsill in the afternoon',
]

console.log('[1/3] local (this platform) ...')
const { handler } = await import('./handler.mjs')
const local = await handler({ texts: TEXTS, return_vectors: true })
console.log(`      node=${local.node} load=${local.load_ms}ms digests=${local.canonical_digests.map(d => d.slice(0, 12)).join(',')}`)

console.log(`[2/3] lambda ${FN} ...`)
const pf = join(tmpdir(), 'onnx-verify-payload.json')
const out = join(tmpdir(), 'onnx-verify-out.json')
writeFileSync(pf, JSON.stringify({ texts: TEXTS, return_vectors: true }))
const meta = execFileSync(AWS_CLI, ['lambda', 'invoke', '--function-name', FN,
  '--cli-binary-format', 'raw-in-base64-out', '--payload', `file://${pf.replace(/\\/g, '/')}`, out,
  '--query', '[StatusCode,FunctionError]', '--output', 'text'], { encoding: 'utf8' }).trim()
assert.ok(meta.startsWith('200') && !meta.includes('Unhandled'), `invoke failed: ${meta}`)
const remote = JSON.parse(readFileSync(out, 'utf8'))
rmSync(pf, { force: true }); rmSync(out, { force: true })
console.log(`      node=${remote.node} load=${remote.load_ms}ms digests=${remote.canonical_digests.map(d => d.slice(0, 12)).join(',')}`)

console.log('[3/3] compare ...')
assert.equal(local.embedding_model_id, remote.embedding_model_id, 'model identity must match')
let allEqual = true, maxAbsDiff = 0
for (let i = 0; i < TEXTS.length; i++) {
  const dl = local.canonical_digests[i], dr = remote.canonical_digests[i]
  const eq = dl === dr
  allEqual &&= eq
  let diff = 0
  for (let j = 0; j < 512; j++) diff = Math.max(diff, Math.abs(local.vectors[i][j] - remote.vectors[i][j]))
  maxAbsDiff = Math.max(maxAbsDiff, diff)
  console.log(`      text${i}: digest ${eq ? 'EQUAL' : 'DIFFERENT'} (${dl.slice(0, 16)} vs ${dr.slice(0, 16)}), max_abs_diff=${diff}`)
}
console.log(allEqual
  ? `VERDICT: full-512 canonical digests identical across platforms (bit-exact), max_abs_diff=${maxAbsDiff}`
  : `VERDICT: NOT bit-exact; numeric agreement max_abs_diff=${maxAbsDiff} - claims must say approximate`)
