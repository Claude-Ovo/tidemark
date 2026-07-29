// HMAC key 解析单测：node src/test-config.mjs
import assert from 'node:assert/strict'
import { resolveHmacKey } from './lib/config.mjs'

assert.equal(resolveHmacKey({ TIDEMARK_HMAC_KEY: 'real-key' }), 'real-key', 'explicit key wins')
assert.equal(resolveHmacKey({ TIDEMARK_HMAC_KEY: 'real', TIDEMARK_DEV_INSECURE: '1' }), 'real', 'explicit key beats dev flag')
assert.equal(resolveHmacKey({ TIDEMARK_DEV_INSECURE: '1' }), 'dev-only-hmac-key', 'unset + dev flag -> dev key')
assert.equal(resolveHmacKey({ TIDEMARK_HMAC_KEY: '', TIDEMARK_DEV_INSECURE: '1' }), 'dev-only-hmac-key', 'EMPTY STRING from .env.example + dev flag -> dev key (Codex repro)')
assert.equal(resolveHmacKey({ TIDEMARK_HMAC_KEY: '   ', TIDEMARK_DEV_INSECURE: '1' }), 'dev-only-hmac-key', 'whitespace-only counts as unset')
assert.equal(resolveHmacKey({ TIDEMARK_HMAC_KEY: '' }), null, 'empty without dev flag -> fail closed')
assert.equal(resolveHmacKey({}), null, 'nothing -> fail closed')
console.log('ALL CONFIG TESTS PASSED (7 cases)')
