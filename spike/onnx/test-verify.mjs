// verify.mjs 的验收门自测（round-3 P1-1 要求的反例）：
// --self-test-mismatch 伪造远端扰动一维 -> verify 必须以非零退出码收场。
// 本测试不碰 AWS，只证明"检出不一致时会红"。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// 反例 A：向量扰动 + 声明 digest 同步重算——须死在重算 digest 比较（DIFFERENT）
{
  const r = spawnSync(process.execPath, [join(here, 'verify.mjs'), '--self-test-mismatch'], { encoding: 'utf8' })
  assert.notEqual(r.status, 0, `verify must exit non-zero on mismatch, got ${r.status}\n${r.stdout}\n${r.stderr}`)
  assert.ok((r.stdout + r.stderr).includes('DIFFERENT'), 'mismatch must be reported per-text')
  assert.ok((r.stdout + r.stderr).includes('NOT bit-exact'), 'verdict must state the failure')
  console.log('PASS A: perturbed vector with honest digest turns red (recompute comparison)')
}

// 反例 B（round-4）：向量扰动、声明 digest 保持旧值——自报不可信，须死在 validateSide 对账
{
  const r = spawnSync(process.execPath, [join(here, 'verify.mjs'), '--self-test-stale-digest'], { encoding: 'utf8' })
  assert.notEqual(r.status, 0, `verify must exit non-zero on stale declared digest, got ${r.status}\n${r.stdout}\n${r.stderr}`)
  assert.ok((r.stdout + r.stderr).includes('self-report distrusted'), 'stale declared digest must fail the reconciliation assert')
  console.log('PASS B: stale declared digest with changed vector turns red (self-report distrusted)')
}
console.log('ALL verify gate self-tests passed (A mismatch + B stale-digest)')
