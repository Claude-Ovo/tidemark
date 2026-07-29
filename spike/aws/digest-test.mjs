// digest canonical 化回归测试——import 生产实现本体（vector-canonical.mjs），不复制
// node digest-test.mjs，退出码生效。随机批次用固定 seed，证据可复现。
import assert from 'node:assert/strict'
import { DIMS, toF32, canonicalDigest, toVectorLiteral, parseVector } from './vector-canonical.mjs'

// mulberry32：确定性 PRNG，seed 固定
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// 1. Codex 反例：float32 roundtrip 必须稳定
{
  const raw = [0.678750162244703, ...Array(DIMS - 1).fill(0)]
  const f32 = toF32(raw)
  const d1 = canonicalDigest(f32)
  const roundtrip = parseVector(toVectorLiteral(f32))
  assert.equal(canonicalDigest(roundtrip), d1, 'counterexample must survive roundtrip')
  console.log('PASS counterexample 0.678750162244703 roundtrip-stable')
}

// 2. 固定 seed 随机批次 roundtrip（20 x 512）
{
  const rand = mulberry32(20260729)
  for (let t = 0; t < 20; t++) {
    const raw = Array.from({ length: DIMS }, () => rand() * 2 - 1)
    const f32 = toF32(raw)
    assert.equal(canonicalDigest(parseVector(toVectorLiteral(f32))), canonicalDigest(f32), `seeded batch ${t}`)
  }
  console.log('PASS 20x512 seeded(20260729) roundtrip-stable')
}

// 3. 负例四连：511 / 513 / NaN / Infinity 必须抛
{
  assert.throws(() => toF32(Array(DIMS - 1).fill(0)), /length 511/, '511 must throw')
  assert.throws(() => toF32(Array(DIMS + 1).fill(0)), /length 513/, '513 must throw')
  assert.throws(() => toF32([NaN, ...Array(DIMS - 1).fill(0)]), /non-finite/, 'NaN must throw')
  assert.throws(() => toF32([Infinity, ...Array(DIMS - 1).fill(0)]), /non-finite/, 'Infinity must throw')
  console.log('PASS negatives 511/513/NaN/Infinity all rejected')
}
console.log('ALL DIGEST TESTS PASSED')
