// P0-09 Secrets Manager 引导（round-2 修 P0-1：生产完整性 fail-closed）：
// - Lambda 冷启动时按 TIDEMARK_SECRET_ARN 拉取一个 JSON secret，把白名单键注入 process.env；
//   pool 是惰性创建（getPool 首次调用），所以只要 handler 在业务代码前 await bootstrapSecrets()
//   即可保证凭据先于任何连接存在
// - 白名单注入：secret 里出现的未知键一律忽略并告警——secret 被污染不能变成任意 env 注入
// - 已有环境变量优先（本地 --env-file 开发 / 测试注入 stub 时 secret 不得覆盖）：
//   fail-visible 而不是静默换值
// - 【生产完整性契约】只要配置了 TIDEMARK_SECRET_ARN（= 生产模式信号），合并（env 优先 + secret
//   注入）后四个生产键必须【全部非空】：COCKROACH_DATABASE_URL / TIDEMARK_HMAC_KEY /
//   TIDEMARK_ADMIN_KEY / TIDEMARK_AGENT_KEYS。任一缺失 = 冷启动失败——secret 配置漂移
//   绝不静默降级到内置 dev 凭据（那是 fail-open，Codex P0-09 一审 P0-1）
// - 无 TIDEMARK_SECRET_ARN 时本函数是 no-op（本地开发路径零改动）
// - 缓存跨 warm invoke；拉取失败 fail-closed 抛出（宁可 5xx 也不带残缺配置服务请求）
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const REQUIRED_IN_PROD = [
  'COCKROACH_DATABASE_URL',
  'TIDEMARK_HMAC_KEY',
  'TIDEMARK_ADMIN_KEY',
  'TIDEMARK_AGENT_KEYS',
]
const ALLOWED_KEYS = new Set(REQUIRED_IN_PROD)

let loaded = null
export const _resetSecretsCacheForTest = () => { loaded = null }

export const bootstrapSecrets = async ({ _client } = {}) => {
  const arn = process.env.TIDEMARK_SECRET_ARN
  if (!arn) return { source: 'env_only' }
  if (loaded) return loaded
  const client = _client ?? new SecretsManagerClient({})
  const r = await client.send(new GetSecretValueCommand({ SecretId: arn }))
  if (!r.SecretString) throw new Error('secret has no SecretString (binary secrets unsupported)')
  let obj
  try { obj = JSON.parse(r.SecretString) } catch { throw new Error('secret is not valid JSON') }
  const applied = [], skipped = []
  for (const [k, v] of Object.entries(obj)) {
    if (!ALLOWED_KEYS.has(k)) { skipped.push(k); continue }
    if (typeof v !== 'string' || v.length === 0) throw new Error(`secret key ${k} must be a non-empty string`)
    if (process.env[k] !== undefined) { skipped.push(`${k}(env-precedence)`); continue }
    process.env[k] = v
    applied.push(k)
  }
  // 生产完整性：合并结果里四键齐全才放行，缺哪个点名哪个（fail-closed 且 fail-visible）
  const missing = REQUIRED_IN_PROD.filter(k => !process.env[k])
  if (missing.length > 0) throw new Error(`production secret incomplete after merge: missing ${missing.join(', ')}`)
  // 只打键名不打值：applied/skipped 是诊断面，凭据本身永不落日志
  console.log(JSON.stringify({ evt: 'secrets_bootstrap', applied, skipped }))
  loaded = { source: 'secrets_manager', applied }
  return loaded
}
