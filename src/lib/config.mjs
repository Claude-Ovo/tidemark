// 配置解析（可单测）：HMAC key 按【非空值】判断——.env.example 复制产生的空串不算已配置
export const resolveHmacKey = (env) => {
  const raw = env.TIDEMARK_HMAC_KEY
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  if (env.TIDEMARK_DEV_INSECURE === '1') return 'dev-only-hmac-key'
  return null   // fail-closed：调用方必须抛
}
