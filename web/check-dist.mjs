// 三审 P1-1 构建门：production artifact 必须包含潮池页，缺了就红——
// dev proxy 草图不算交付。build 脚本末位自动执行。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

assert.ok(existsSync('dist/pool.html'), 'dist/pool.html missing from production build')
const html = readFileSync('dist/pool.html', 'utf8')
// 四审 P2：只认实际 hashed bundle 入口——`type="module"` fallback 会放过未 bundle 的开发入口
assert.ok(/assets\/pool-[\w-]+\.js/.test(html), 'pool.html has no hashed bundled entry (assets/pool-*.js)')
assert.ok(existsSync('dist/index.html'), 'dist/index.html missing')
assert.ok(existsSync('dist/evidence.html'), 'dist/evidence.html missing')
const evidenceHtml = readFileSync('dist/evidence.html', 'utf8')
assert.ok(/assets\/evidence-[\w-]+\.js/.test(evidenceHtml), 'evidence.html has no hashed bundled entry (assets/evidence-*.js)')
console.log('ok - dist contains pool.html and evidence.html with module entries')
