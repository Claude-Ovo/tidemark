// 向量 canonical 化的唯一实现——handler 与测试共同 import，杜绝复制品分叉
import { createHash } from 'node:crypto'

export const DIMS = 512

export const toF32 = (vec) => {
  if (!Array.isArray(vec) && !(vec instanceof Float32Array)) throw new Error('vector must be array')
  if (vec.length !== DIMS) throw new Error(`embedding length ${vec.length} != ${DIMS}`)
  const f = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) {
    const v = Math.fround(vec[i])
    if (!Number.isFinite(v)) throw new Error(`non-finite component at ${i}`)
    f[i] = v
  }
  return f
}

export const canonicalDigest = (f32) =>
  createHash('sha256').update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest('hex')

export const toVectorLiteral = (f32) => '[' + Array.from(f32, v => String(v)).join(',') + ']'

export const parseVector = (s) => toF32(s.replace(/^\[|\]$/g, '').split(',').map(Number))
