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
const SELF_TEST_STALE = process.argv[2] === '--self-test-stale-digest'
const FN = (!SELF_TEST && !SELF_TEST_STALE && process.argv[2]) || 'tidemark-embed-spike'
const AWS_CLI = process.env.AWS_CLI_PATH || 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
const TEXTS = [
  'the deployment failed because the API key was invalid',
  'authentication credentials were wrong so the release did not go through',
  'my cat enjoys sleeping on the warm windowsill in the afternoon',
]
const RX_HEX64 = /^[0-9a-f]{64}$/

// 结构校验 + 自报不信任（round-4 P1-1）：数量、512 维、全有限值、64-hex 形状，然后
// 用正式 canonical 算法从【返回的 vectors】重算 digest 并与声明值比对——远端缓存/回归
// 送来"旧 digest 配新向量"在这里直接爆，比较阶段只用重算值。
import { toF32, canonicalDigest } from './vector-canonical.mjs'
const validateSide = (label, r) => {
  assert.ok(Array.isArray(r.vectors) && r.vectors.length === TEXTS.length, `${label}: vectors missing or wrong count`)
  assert.ok(Array.isArray(r.canonical_digests) && r.canonical_digests.length === TEXTS.length, `${label}: digests wrong count`)
  const recomputed = []
  for (let i = 0; i < TEXTS.length; i++) {
    assert.equal(r.vectors[i].length, 512, `${label}: text${i} must be 512 dims`)
    assert.ok(r.vectors[i].every(Number.isFinite), `${label}: text${i} has non-finite components`)
    assert.ok(RX_HEX64.test(r.canonical_digests[i]), `${label}: text${i} digest is not 64-hex`)
    const rc = canonicalDigest(toF32(r.vectors[i]))
    assert.equal(rc, r.canonical_digests[i], `${label}: text${i} DECLARED digest does not match vector recompute (self-report distrusted)`)
    recomputed.push(rc)
  }
  return recomputed
}

console.log('[1/3] local (this platform) ...')
const { handler } = await import('./handler.mjs')
const local = await handler({ texts: TEXTS, return_vectors: true })
const localRecomputed = validateSide('local', local)
console.log(`      node=${local.node} load=${local.load_ms}ms id=${local.embedding_model_id.slice(0, 60)}...`)

let remote
if (SELF_TEST) {
  // 伪造远端 A：扰动一维【并同步重算声明 digest】——须在重算比较阶段爆（digest 不等）
  console.log('[2/3] fake remote (self-test mismatch) ...')
  remote = JSON.parse(JSON.stringify(local))
  remote.vectors[1][7] += 1e-3
  remote.canonical_digests[1] = canonicalDigest(toF32(remote.vectors[1]))
} else if (SELF_TEST_STALE) {
  // 伪造远端 B（round-4 反例）：扰动一维【但声明 digest 保持旧值】——自报不可信，
  // 须在 validateSide 的重算对账处爆
  console.log('[2/3] fake remote (self-test stale declared digest) ...')
  remote = JSON.parse(JSON.stringify(local))
  remote.vectors[1][7] += 1e-3
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
const remoteRecomputed = validateSide('remote', remote)
console.log(`      node=${remote.node} load=${remote.load_ms}ms id=${remote.embedding_model_id.slice(0, 60)}...`)

console.log('[3/3] compare (recomputed digests only, self-reports already reconciled) ...')
assert.equal(local.embedding_model_id, remote.embedding_model_id, 'model identity must match')
let allEqual = true, maxAbsDiff = 0
for (let i = 0; i < TEXTS.length; i++) {
  const eq = localRecomputed[i] === remoteRecomputed[i]
  allEqual &&= eq
  let diff = 0
  for (let j = 0; j < 512; j++) diff = Math.max(diff, Math.abs(local.vectors[i][j] - remote.vectors[i][j]))
  maxAbsDiff = Math.max(maxAbsDiff, diff)
  console.log(`      text${i}: recomputed digest ${eq ? 'EQUAL' : 'DIFFERENT'} (${localRecomputed[i].slice(0, 16)} vs ${remoteRecomputed[i].slice(0, 16)}), max_abs_diff=${diff}`)
}
// bit-exact = 重算 digest 全等【且】数值零差——单靠任何一边都不算（round-4 P1-1）
if (!allEqual || maxAbsDiff !== 0) {
  throw new Error(`NOT bit-exact across platforms (digests_equal=${allEqual}, max_abs_diff=${maxAbsDiff}); claims must say approximate`)
}
console.log(`VERDICT: full-512 recomputed canonical digests identical across platforms (bit-exact), max_abs_diff=${maxAbsDiff}`)
