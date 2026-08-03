// local-onnx 验收卷（结论 55 / Codex 六条边界 #6）：不碰 DB，直接打 embed-local-onnx 模块。
// E1 spike 锚点：三条文本的完整 canonical digest 必须与已签署 spike 实测值逐字节一致
//    ——钉死"主树实现 == spike pipeline 路径"，也钉死跨版本回归
// E2 确定性 / E3 语义分辨 / E4 零填充 cosine 等价 / E5 截断契约 / E6 缺模型 fail-closed（子进程）
// E7 身份形状：完整 64-hex、embed() 落库值 == 派生值
import './lib/test-env.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { embedLocalOnnx } from './lib/embed-local-onnx.mjs'
import { embedIdentity } from './lib/embed-identity.mjs'
import { toF32, canonicalDigest } from './lib/vector-canonical.mjs'

const TEXTS = [
  'the deployment failed because the API key was invalid',
  'authentication credentials were wrong so the release did not go through',
  'my cat enjoys sleeping on the warm windowsill in the afternoon',
]
// 2026-08-02 spike 实测（win32/node24 与 linux/node22 双平台一致，见 docs/SPIKE-ONNX.md）
const SPIKE_DIGEST_PREFIX = ['a66a8bf98c2084e3', 'bbf136dee7a9db36', '48a5101a22c7a4ee']

const cos = (a, b, n) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s }

// E1 spike 锚点 + E3 语义
{
  const rs = []
  for (let i = 0; i < TEXTS.length; i++) {
    const r = await embedLocalOnnx(TEXTS[i])
    const d = canonicalDigest(toF32(r.vector))
    assert.ok(d.startsWith(SPIKE_DIGEST_PREFIX[i]), `E1 text${i}: digest ${d.slice(0, 16)} != spike ${SPIKE_DIGEST_PREFIX[i]}`)
    rs.push(r)
  }
  console.log('PASS E1 spike digest anchors hold (main tree == signed spike outputs)')
  const para = cos(rs[0].vector, rs[1].vector, 512)
  const unrel = cos(rs[0].vector, rs[2].vector, 512)
  assert.ok(para > 0.4 && unrel < 0.1 && para > unrel + 0.3,
    `E3 semantic separation: paraphrase=${para.toFixed(4)} unrelated=${unrel.toFixed(4)}`)
  console.log(`PASS E3 real semantics (paraphrase ${para.toFixed(4)} >> unrelated ${unrel.toFixed(4)})`)

  // E4 零填充等价：512 维 cosine 与 384 维前缀 cosine 完全一致（padding 数学无损）
  const c384 = cos(rs[0].vector, rs[1].vector, 384)
  assert.equal(para, c384, 'E4 zero-padding must not change cosine')
  assert.ok(rs[0].vector.slice(384).every(x => x === 0), 'E4 tail must be exactly zero')
  console.log('PASS E4 384->512 zero-padding is cosine-exact')
}

// E2 确定性
{
  const a = await embedLocalOnnx(TEXTS[0])
  const b = await embedLocalOnnx(TEXTS[0])
  assert.equal(canonicalDigest(toF32(a.vector)), canonicalDigest(toF32(b.vector)), 'E2 same input same vector')
  console.log('PASS E2 deterministic embedding')
}

// E5 截断契约（冻结 max_tokens=256）：长文不炸、可观测、确定性
{
  const long = 'deployment retry with exponential backoff '.repeat(220)
  const a = await embedLocalOnnx(long)
  assert.equal(a.truncated, true, 'E5 long input must be flagged truncated')
  assert.ok(a.token_count > 256, `E5 token_count ${a.token_count} must exceed the frozen cap`)
  const b = await embedLocalOnnx(long)
  assert.equal(canonicalDigest(toF32(a.vector)), canonicalDigest(toF32(b.vector)), 'E5 truncation is deterministic')
  const short = await embedLocalOnnx(TEXTS[0])
  assert.equal(short.truncated, false, 'E5 short input must not be flagged')
  console.log(`PASS E5 truncation contract (observable flag, tokens=${a.token_count}, deterministic)`)
}

// E5b 256 边界判别力（Codex round-2 红门）：前 256 token 完全相同、尾部不同的两段文本
// 必须产出【完全相同】的向量且都被标记 truncated——证明 257+ 的内容真的没被消费
{
  const prefix = 'memory '.repeat(300)          // 约 300+ tokens，远超 256
  const a = await embedLocalOnnx(prefix + 'cat')
  const b = await embedLocalOnnx(prefix + 'database entirely different tail content here')
  assert.equal(a.truncated, true, 'E5b variant A flagged')
  assert.equal(b.truncated, true, 'E5b variant B flagged')
  assert.equal(canonicalDigest(toF32(a.vector)), canonicalDigest(toF32(b.vector)),
    'E5b identical first-256-token prefix must yield IDENTICAL vectors (tail is provably not consumed)')
  assert.notEqual(a.token_count, b.token_count, 'E5b full-text counts still observable and distinct')
  console.log('PASS E5b frozen 256 boundary: identical prefix -> identical vector, tails not consumed')
}

// E6 缺模型 fail-closed（子进程：单例缓存使同进程无法复测坏目录）
{
  const emptyDir = mkdtempSync(join(tmpdir(), 'tidemark-nomodel-'))
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import('${new URL('./lib/embed-local-onnx.mjs', import.meta.url).href}').then(m => m.embedLocalOnnx('x')).then(() => { console.log('SHOULD_NOT_SUCCEED'); process.exit(0) }, (e) => { console.error(e.message); process.exit(3) })`],
      { encoding: 'utf8', env: { ...process.env, TIDEMARK_MODEL_DIR: emptyDir }, cwd: join(process.cwd()) })
    assert.equal(r.status, 3, `E6 missing artifacts must fail closed, got ${r.status}\n${r.stdout}${r.stderr}`)
    assert.ok(r.stderr.includes('model artifact missing'), 'E6 error must name the missing artifact')
    console.log('PASS E6 missing model artifacts fail closed (subprocess)')
  } finally { rmSync(emptyDir, { recursive: true, force: true }) }
}

// E7 身份形状与一致性
{
  const id = embedIdentity()
  assert.match(id.embedding_model_id, /#[0-9a-f]{64}$/, 'E7 identity carries the FULL 64-hex digest')
  assert.match(id.display_id, /#[0-9a-f]{12}$/, 'E7 display id is the short form')
  const r = await embedLocalOnnx(TEXTS[0])
  assert.equal(r.embedding_model_id, id.embedding_model_id, 'E7 embed() must return the derived identity verbatim')
  console.log('PASS E7 identity: full 64-hex, derived, single-sourced')
}

console.log('ALL LOCAL-ONNX EMBED ASSERTIONS PASSED (E1-E7)')
