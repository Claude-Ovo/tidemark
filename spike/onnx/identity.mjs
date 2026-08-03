// embedding 身份派生（round-3 修 P1-2：禁止手写副本，身份必须随输出变化）。
// identity = 可读前缀 + 完整 canonical digest，输入覆盖：full commit、四件套 SHA、
// dtype/pooling/normalize/dims、transformers 与 onnxruntime 实际安装版本。
// manifest 不再携带 embedding_model_id；任何影响向量空间的字段变化都会改变 digest。
// 同时对账：manifest.transformers_version 必须等于 node_modules 实际安装版本（fail-closed）。
// CLI: node identity.mjs --print [staging-dir]   （staging-dir 默认 = 本文件所在目录）
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const stableStringify = (x) => {
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']'
  if (x && typeof x === 'object') {
    return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}'
  }
  return JSON.stringify(x)
}

const pkgVersion = (base, name) => {
  try { return JSON.parse(readFileSync(join(base, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version }
  catch { throw new Error(`cannot read installed version of ${name} under ${base} (fail-closed)`) }
}

export const deriveEmbeddingModelId = (baseDir) => {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url))
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))
  const transformersInstalled = pkgVersion(here, '@huggingface/transformers')
  const ortInstalled = pkgVersion(here, 'onnxruntime-node')
  if (transformersInstalled !== manifest.transformers_version) {
    throw new Error(`transformers version drift: manifest=${manifest.transformers_version} installed=${transformersInstalled}`)
  }
  const canonical = stableStringify({
    model_repo: manifest.model_repo,
    model_commit: manifest.model_commit,          // full commit
    files: manifest.files,                        // 四件套 SHA256
    output: manifest.output,                      // dtype/pooling/normalize/dims/pad
    transformers_version: transformersInstalled,
    onnxruntime_version: ortInstalled,
  })
  const digest = createHash('sha256').update(canonical).digest('hex')
  const o = manifest.output
  const prefix = `${manifest.model_repo}@${manifest.model_commit.slice(0, 8)}:${o.dtype}:${o.pooling}:${o.normalize ? 'l2' : 'raw'}:pad${o.pad_to}`
  return { embedding_model_id: `${prefix}#${digest.slice(0, 12)}`, identity_digest: digest, manifest }
}

if (process.argv[2] === '--print') {
  const { embedding_model_id, identity_digest } = deriveEmbeddingModelId(process.argv[3])
  console.log(JSON.stringify({ embedding_model_id, identity_digest }))
}
