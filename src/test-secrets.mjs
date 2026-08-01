// P0-09 round-2 单测：secrets 生产完整性契约（P0-1 fail-open 修复的回归卷）。
// 无 DB/无网络：SecretsManagerClient 经 _client seam 注入假件。
import './lib/test-env.mjs'
import assert from 'node:assert/strict'
import { bootstrapSecrets, _resetSecretsCacheForTest } from './lib/secrets.mjs'
import { resolveAuthMap, _resetAuthMapCacheForTest } from './server.mjs'

const PROD_KEYS = ['COCKROACH_DATABASE_URL', 'TIDEMARK_HMAC_KEY', 'TIDEMARK_ADMIN_KEY', 'TIDEMARK_AGENT_KEYS']
const FULL_SECRET = {
  COCKROACH_DATABASE_URL: 'postgresql://u:p@h:26257/defaultdb',
  TIDEMARK_HMAC_KEY: 'hmac-secret',
  TIDEMARK_ADMIN_KEY: 'admin-secret',
  TIDEMARK_AGENT_KEYS: JSON.stringify({ k1: { tenant_id: 't', agent_id: 'a', capabilities: [] } }),
}
const fakeClient = (obj, calls = { n: 0 }) => ({
  calls,
  send: async () => { calls.n++; return { SecretString: typeof obj === 'string' ? obj : JSON.stringify(obj) } },
})
// 每个场景从干净 env 出发：清四键 + ARN + 缓存
const clean = () => {
  for (const k of PROD_KEYS) delete process.env[k]
  delete process.env.TIDEMARK_SECRET_ARN
  _resetSecretsCacheForTest()
  _resetAuthMapCacheForTest()
}

// ===== B1 无 ARN：no-op，本地路径零改动 =====
clean()
{
  const r = await bootstrapSecrets({ _client: fakeClient({}) })
  assert.equal(r.source, 'env_only')
  console.log('PASS B1 no ARN is a no-op')
}

// ===== B2 完整 secret：四键全注入 =====
clean()
{
  process.env.TIDEMARK_SECRET_ARN = 'arn:test'
  const r = await bootstrapSecrets({ _client: fakeClient(FULL_SECRET) })
  assert.equal(r.source, 'secrets_manager')
  assert.deepEqual([...r.applied].sort(), [...PROD_KEYS].sort())
  for (const k of PROD_KEYS) assert.ok(process.env[k], k)
  console.log('PASS B2 full secret applies all four production keys')
}

// ===== B3 逐个缺键：合并后任一生产键缺失 = 冷启动失败并点名（P0-1 核心）=====
for (const missing of PROD_KEYS) {
  clean()
  process.env.TIDEMARK_SECRET_ARN = 'arn:test'
  const partial = { ...FULL_SECRET }
  delete partial[missing]
  await assert.rejects(
    () => bootstrapSecrets({ _client: fakeClient(partial) }),
    (e) => e.message.includes('production secret incomplete') && e.message.includes(missing),
    `missing ${missing} must fail cold start by name`)
}
console.log('PASS B3 each missing production key fails cold start by name (4/4)')

// ===== B4 未知键忽略不注入（secret 污染不得变 env 注入）=====
clean()
{
  process.env.TIDEMARK_SECRET_ARN = 'arn:test'
  await bootstrapSecrets({ _client: fakeClient({ ...FULL_SECRET, NODE_OPTIONS: '--evil', PATH: '/evil' }) })
  assert.notEqual(process.env.NODE_OPTIONS, '--evil')
  assert.notEqual(process.env.PATH, '/evil')
  console.log('PASS B4 unknown keys are never injected')
}

// ===== B5 env 优先：已有环境变量不被 secret 覆盖 =====
clean()
{
  process.env.TIDEMARK_SECRET_ARN = 'arn:test'
  process.env.TIDEMARK_HMAC_KEY = 'from-env'
  await bootstrapSecrets({ _client: fakeClient(FULL_SECRET) })
  assert.equal(process.env.TIDEMARK_HMAC_KEY, 'from-env')
  console.log('PASS B5 env takes precedence over secret')
}

// ===== B6/B7 形状非法 fail-closed =====
clean()
{
  process.env.TIDEMARK_SECRET_ARN = 'arn:test'
  await assert.rejects(() => bootstrapSecrets({ _client: fakeClient({ ...FULL_SECRET, TIDEMARK_HMAC_KEY: '' }) }), /non-empty string/)
  _resetSecretsCacheForTest()
  await assert.rejects(() => bootstrapSecrets({ _client: fakeClient('not json {') }), /not valid JSON/)
  console.log('PASS B6/B7 empty value and malformed JSON fail closed')
}

// ===== B8 缓存跨 warm invoke：第二次调用不再打 Secrets Manager =====
clean()
{
  process.env.TIDEMARK_SECRET_ARN = 'arn:test'
  const calls = { n: 0 }
  const c = fakeClient(FULL_SECRET, calls)
  await bootstrapSecrets({ _client: c })
  await bootstrapSecrets({ _client: c })
  assert.equal(calls.n, 1)
  console.log('PASS B8 warm invokes hit the cache, not the API')
}

// ===== A 系列：dev key 表可达性矩阵（P0-1 的 server 侧闸门）=====
// A1 显式本地不安全 + 非生产：dev 表可达
clean()
{
  process.env.TIDEMARK_DEV_INSECURE = '1'
  const m = resolveAuthMap()
  assert.ok(m['spike-demo-key'], 'dev map reachable in explicit local insecure mode')
  console.log('PASS A1 dev keys reachable only in explicit local insecure mode')
}

// A2 生产信号在场（ARN）：即使 DEV_INSECURE=1 也拒绝 dev 表
clean()
{
  process.env.TIDEMARK_DEV_INSECURE = '1'
  process.env.TIDEMARK_SECRET_ARN = 'arn:test'
  assert.throws(() => resolveAuthMap(), /TIDEMARK_AGENT_KEYS missing/)
  console.log('PASS A2 production ARN forbids the dev key table even under DEV_INSECURE')
}

// A3 无不安全声明：缺表直接拒
clean()
{
  delete process.env.TIDEMARK_DEV_INSECURE
  assert.throws(() => resolveAuthMap(), /TIDEMARK_AGENT_KEYS missing/)
  console.log('PASS A3 missing table without DEV_INSECURE fails closed')
}

// A4 生产表在场：整表取代，dev key 不可达
clean()
{
  process.env.TIDEMARK_AGENT_KEYS = FULL_SECRET.TIDEMARK_AGENT_KEYS
  const m = resolveAuthMap()
  assert.ok(m.k1)
  assert.equal(m['spike-demo-key'], undefined, 'dev keys must vanish when production table present')
  console.log('PASS A4 production table replaces dev table entirely')
}

// A5/A6 表形状非法/空表：拒
clean()
{
  process.env.TIDEMARK_AGENT_KEYS = JSON.stringify({ bad: { tenant_id: 't' } })
  assert.throws(() => resolveAuthMap(), /entry invalid/)
  _resetAuthMapCacheForTest()
  process.env.TIDEMARK_AGENT_KEYS = '{}'
  assert.throws(() => resolveAuthMap(), /must not be empty/)
  console.log('PASS A5/A6 malformed and empty tables fail closed')
}

clean()
process.env.TIDEMARK_DEV_INSECURE = '1'   // 恢复测试进程基线
console.log('ALL P0-09 SECRETS/AUTH-MAP ASSERTIONS PASSED (B1-B8 A1-A6)')
