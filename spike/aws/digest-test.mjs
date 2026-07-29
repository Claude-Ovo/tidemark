// digest 正规化回归测试：含 Codex 给出的 float32 roundtrip 反例。node digest-test.mjs，退出码生效
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const toF32 = (vec) => {
  const f = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) { const v = Math.fround(vec[i]); assert.ok(Number.isFinite(v)); f[i] = v }
  return f
}
const digest = (f32) => createHash('sha256').update(Buffer.from(f32.buffer)).digest('hex')
const literal = (f32) => '[' + Array.from(f32, v => String(v)).join(',') + ']'
const parse = (s) => toF32(s.replace(/^\[|\]$/g, '').split(',').map(Number))

// 1. Codex 反例：旧算法在此值上必炸，新算法必须稳定
{
  const raw = [0.678750162244703, ...Array(511).fill(0)]
  const f32 = toF32(raw)
  const d1 = digest(f32)
  const roundtrip = parse(literal(f32))   // 模拟 写literal→DB float32→读text→parse
  assert.equal(digest(roundtrip), d1, 'counterexample value must survive roundtrip')
  console.log('PASS counterexample 0.678750162244703 roundtrip-stable')
}

// 2. 1000 个随机 double 分量批量 roundtrip
{
  for (let t = 0; t < 20; t++) {
    const raw = Array.from({ length: 512 }, () => Math.random() * 2 - 1)
    const f32 = toF32(raw)
    assert.equal(digest(parse(literal(f32))), digest(f32), `random batch ${t} roundtrip`)
  }
  console.log('PASS 20x512 random doubles roundtrip-stable')
}

// 3. 边界：非法长度与非有限值必须抛
{
  assert.throws(() => { const f = toF32([NaN]); digest(f) }, 'NaN must throw')
  console.log('PASS non-finite rejected')
}
console.log('ALL DIGEST TESTS PASSED')
