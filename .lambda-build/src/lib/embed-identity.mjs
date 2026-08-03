// embedding 身份派生（结论 55 契约，与 spike/onnx/identity.mjs 同算法，主树版）：
// identity = 可读前缀 + '#' + 完整 64-hex canonical digest。输入覆盖 full commit、
// 四件套 SHA、dtype/pooling/normalize/dims、transformers 与 onnxruntime 实际安装版本
//（与 manifest 声明对账，漂移即抛）。DB/pipeline 一律用完整值；短值仅展示，禁止落库。
// manifest 真相源：仓库根 embed-manifest.json（spike/onnx/manifest.json 是冻结的
// spike 期证据副本，不再演进）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const stableStringify = (x) => {
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']'
  if (x && typeof x === 'object') {
    return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}'
  }
  return JSON.stringify(x)
}

const pkgVersion = (name) => {
  try { return JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version }
  catch { throw new Error(`cannot read installed version of ${name} (fail-closed)`) }
}

let cached = null
export const embedIdentity = () => {
  if (cached) return cached
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'embed-manifest.json'), 'utf8'))
  const transformersInstalled = pkgVersion('@huggingface/transformers')
  const ortInstalled = pkgVersion('onnxruntime-node')
  if (transformersInstalled !== manifest.transformers_version) {
    throw new Error(`transformers version drift: manifest=${manifest.transformers_version} installed=${transformersInstalled}`)
  }
  const digest = createHash('sha256').update(stableStringify({
    model_repo: manifest.model_repo,
    model_commit: manifest.model_commit,
    files: manifest.files,
    output: manifest.output,
    transformers_version: transformersInstalled,
    onnxruntime_version: ortInstalled,
  })).digest('hex')
  const o = manifest.output
  const prefix = `${manifest.model_repo}@${manifest.model_commit.slice(0, 8)}:${o.dtype}:${o.pooling}:${o.normalize ? 'l2' : 'raw'}:pad${o.pad_to}`
  cached = {
    embedding_model_id: `${prefix}#${digest}`,
    display_id: `${prefix}#${digest.slice(0, 12)}`,
    identity_digest: digest,
    manifest,
    repo_root: REPO_ROOT,
  }
  return cached
}
