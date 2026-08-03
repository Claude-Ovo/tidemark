// verify.mjs 的验收门自测（round-3 P1-1 要求的反例）：
// --self-test-mismatch 伪造远端扰动一维 -> verify 必须以非零退出码收场。
// 本测试不碰 AWS，只证明"检出不一致时会红"。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const r = spawnSync(process.execPath, [join(here, 'verify.mjs'), '--self-test-mismatch'], { encoding: 'utf8' })
assert.notEqual(r.status, 0, `verify must exit non-zero on mismatch, got ${r.status}\n${r.stdout}\n${r.stderr}`)
assert.ok((r.stdout + r.stderr).includes('DIFFERENT'), 'mismatch must be reported per-text')
assert.ok((r.stdout + r.stderr).includes('NOT bit-exact'), 'verdict must state the failure')
console.log('PASS verify.mjs turns red on mismatch (non-zero exit, explicit verdict)')
