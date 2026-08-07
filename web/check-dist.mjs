// 三审 P1-1 构建门：production artifact 必须包含潮池页，缺了就红——
// dev proxy 草图不算交付。build 脚本末位自动执行。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

assert.ok(existsSync('dist/pool.html'), 'dist/pool.html missing from production build')
const html = readFileSync('dist/pool.html', 'utf8')
assert.ok(/assets\/pool-.*\.js/.test(html) || /type="module"/.test(html), 'pool.html has no bundled module entry')
assert.ok(existsSync('dist/index.html'), 'dist/index.html missing')
console.log('ok - dist contains pool.html with module entry')
