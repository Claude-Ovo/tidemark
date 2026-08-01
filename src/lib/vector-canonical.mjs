// 向量 canonical 化的唯一实现（P0-01 五轮审定的算法原文，P0-09 起实现体落户本文件：
// 部署包只含 src/migrations/node_modules，跨树 re-export 会在 Lambda 上 ERR_MODULE_NOT_FOUND）。
// spike/aws/vector-canonical.mjs 反向转发本文件；spike 打包脚本按路径直接收本文件——
// 依旧单一实现，杜绝复制品分叉。算法字节不变：f32 round-trip + sha256 over LE bytes。
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
