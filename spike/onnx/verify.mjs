// 跨平台一致性验收（round-3 修 P1-1：失败必须红，可作验收门）：
// 本地(win)与 Lambda(linux) 对同一组文本比较【完整 512 维 canonical digest（正式算法
// 64-hex）】并计算 max_abs_diff。任何结构非法（缺 vectors/维度不对/非有限值）或
// digest 不等 -> throw（非零退出）。临时文件用唯一目录并在 finally 清理。
// 用法: node verify.mjs [function-name]
//       node verify.mjs --self-test-mismatch   （伪造远端扰动一维，断言本脚本会红）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SELF_TEST = process.argv[2] === '--self-test-mismatch'
const FN = (!SELF_TEST && process.argv[2]) || 'tidemark-embed-spike'
const AWS_CLI = process.env.AWS_CLI_PATH || 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
const TEXTS = [
  'the deployment failed because the API key was invalid',
  'authentication credentials were wrong so the release did not go through',
  'my cat enjoys sleeping on the warm windowsill in the afternoon',
]
const RX_HEX64 = /^[0-9a-f]{64}$/

// 结构校验：数量、512 维、全有限值、64-hex digest——先于任何比较（round-3 P1-1）
const validateSide = (label, r) => {
  assert.ok(Array.isArray(r.vectors) && r.vectors.length === TEXTS.length, `${label}: vectors missing or wrong count`)
  assert.ok(Array.isArray(r.canonical_digests) && r.canonical_digests.length === TEXTS.length, `${label}: digests wrong count`)
  for (let i = 0; i < TEXTS.length; i++) {
    assert.equal(r.vectors[i].length, 512, `${label}: text${i} must be 512 dims`)
    assert.ok(r.vectors[i].every(Number.isFinite), `${label}: text${i} has non-finite components`)
    assert.ok(RX_HEX64.test(r.canonical_digests[i]), `${label}: text${i} digest is not 64-hex`)
  }
}

console.log('[1/3] local (this platform) ...')
const { handler } = await import('./handler.mjs')
const local = await handler({ texts: TEXTS, return_vectors: true })
validateSide('local', local)
console.log(`      node=${local.node} load=${local.load_ms}ms id=${local.embedding_model_id}`)

let remote
if (SELF_TEST) {
  // 伪造远端：抄本地结果但扰动 text1 的一维——本脚本必须以非零退出收场
  console.log('[2/3] fake remote (self-test mismatch) ...')
  remote = JSON.parse(JSON.stringify(local))
  remote.vectors[1][7] += 1e-3
  const { toF32, canonicalDigest } = await import('./vector-canonical.mjs')
  remote.canonical_digests[1] = canonicalDigest(toF32(remote.vectors[1]))
} else {
  console.log(`[2/3] lambda ${FN} ...`)
  const tmp = mkdtempSync(join(tmpdir(), 'onnx-verify-'))
  try {
    const pf = join(tmp, 'payload.json'), out = join(tmp, 'out.json')
    writeFileSync(pf, JSON.stringify({ texts: TEXTS, return_vectors: true }))
    const meta = execFileSync(AWS_CLI, ['lambda', 'invoke', '--function-name', FN,
      '--cli-binary-format', 'raw-in-base64-out', '--payload', `file://${pf.replace(/\\/g, '/')}`, out,
      '--query', '[StatusCode,FunctionError]', '--output', 'text'], { encoding: 'utf8' }).trim()
    assert.ok(meta.startsWith('200') && !meta.includes('Unhandled'), `invoke failed: ${meta}`)
    remote = JSON.parse(readFileSync(out, 'utf8'))
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}
validateSide('remote', remote)
console.log(`      node=${remote.node} load=${remote.load_ms}ms id=${remote.embedding_model_id}`)

console.log('[3/3] compare ...')
assert.equal(local.embedding_model_id, remote.embedding_model_id, 'model identity must match')
let allEqual = true, maxAbsDiff = 0
for (let i = 0; i < TEXTS.length; i++) {
  const eq = local.canonical_digests[i] === remote.canonical_digests[i]
  allEqual &&= eq
  let diff = 0
  for (let j = 0; j < 512; j++) diff = Math.max(diff, Math.abs(local.vectors[i][j] - remote.vectors[i][j]))
  maxAbsDiff = Math.max(maxAbsDiff, diff)
  console.log(`      text${i}: digest ${eq ? 'EQUAL' : 'DIFFERENT'} (${local.canonical_digests[i].slice(0, 16)} vs ${remote.canonical_digests[i].slice(0, 16)}), max_abs_diff=${diff}`)
}
if (!allEqual) {
  // 失败必须红：打印结论后以异常收场，调用方/CI 拿到非零退出码
  throw new Error(`NOT bit-exact across platforms (max_abs_diff=${maxAbsDiff}); claims must say approximate`)
}
console.log(`VERDICT: full-512 canonical digests identical across platforms (bit-exact), max_abs_diff=${maxAbsDiff}`)
