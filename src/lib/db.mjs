// 服务层共享连接池：复用 migrations/db.mjs 的既有工具（Codex 已审），池级参数按 SPEC
import pg from 'pg'
import { withDatabase, isRetryableDatabaseError, sleep } from '../../migrations/db.mjs'

const base = process.env.COCKROACH_DATABASE_URL
if (!base) throw new Error('missing COCKROACH_DATABASE_URL')
const dbName = process.env.TIDEMARK_DATABASE || 'tidemark_dev'

let pool
export const getPool = () => {
  if (!pool) {
    // Lambda 每执行环境 max=1（默认）；本地单进程开发用 TIDEMARK_POOL_MAX=10 等效账户并发预算(10x1)
    const max = Number(process.env.TIDEMARK_POOL_MAX || 1)
    if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error(`invalid TIDEMARK_POOL_MAX "${process.env.TIDEMARK_POOL_MAX}"`)
    pool = new pg.Pool({ connectionString: withDatabase(base, dbName), max, connectionTimeoutMillis: 15000 })
    pool.on('error', (e) => console.error(JSON.stringify({ evt: 'pool_idle_error', msg: e.message.slice(0, 120) })))
  }
  return pool
}

// 短 SERIALIZABLE 事务 + 40001 整体重试（上限 5 + jitter），结论 23
export const inSerializableTx = async (fn, label) => {
  const p = getPool()
  for (let attempt = 1; ; attempt++) {
    let client
    try {
      client = await p.connect()          // 连接获取也在重试圈内（serverless 冷唤醒 ECONNRESET）
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const result = await fn(client)
      await client.query('COMMIT')
      client.release()                    // 健康归还
      return result
    } catch (e) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {})
        client.release(e)                 // 带错误归还 = 销毁，防止死连接回池被反复领取
      }
      const retryable = e.code === '40001' || isRetryableDatabaseError(e)
      if (!retryable || attempt >= 5) throw e
      const delay = Math.min(4000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200)
      console.error(JSON.stringify({ evt: 'tx_retry', label, attempt, code: e.code }))
      await sleep(delay)
    }
  }
}
