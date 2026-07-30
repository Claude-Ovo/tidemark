// 服务层共享连接池：复用 migrations/db.mjs 的既有工具（Codex 已审），池级参数按 SPEC
import pg from 'pg'
import { withDatabase, isRetryableDatabaseError, sleep } from '../../migrations/db.mjs'

let pool
export const getPool = () => {
  if (!pool) {
    const base = process.env.COCKROACH_DATABASE_URL   // 惰性检查：单测注入 fake pool 时不需要真实 env
    if (!base) throw new Error('missing COCKROACH_DATABASE_URL')
    const dbName = process.env.TIDEMARK_DATABASE || 'tidemark_dev'
    // Lambda 每执行环境 max=1（默认）；本地单进程开发用 TIDEMARK_POOL_MAX=10 等效账户并发预算(10x1)
    const max = Number(process.env.TIDEMARK_POOL_MAX || 1)
    if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error(`invalid TIDEMARK_POOL_MAX "${process.env.TIDEMARK_POOL_MAX}"`)
    pool = new pg.Pool({
      connectionString: withDatabase(base, dbName), max,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 10000,   // serverless 免费层会掐长空闲连接——主动淘汰，别攒尸体
      keepAlive: true,
    })
    pool.on('error', (e) => console.error(JSON.stringify({ evt: 'pool_idle_error', msg: e.message.slice(0, 120) })))
  }
  return pool
}

// 连接级损坏（销毁连接）与业务级错误（健康归还）的判别：
// 40001 是序列化冲突、23505/CONCURRENT_WINNER 是业务冲突——连接本身健康；
// ECONNRESET/08xxx/57P01 等是链路死亡——必须销毁驱逐
const isConnectionBroken = (e) => isRetryableDatabaseError(e) && e.code !== '40001'

// 短 SERIALIZABLE 事务 + 40001 整体重试（上限 5 + jitter），结论 23
// pool 可注入以便单测 destroy/reuse 语义
export const runTxWithPool = async (pool, fn, label) => {
  for (let attempt = 1; ; attempt++) {
    let client
    try {
      client = await pool.connect()       // 连接获取也在重试圈内（serverless 冷唤醒 ECONNRESET）
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const result = await fn(client)
      await client.query('COMMIT')
      client.release()                    // 健康归还
      return result
    } catch (e) {
      if (client) {
        let rollbackOk = false
        try { await client.query('ROLLBACK'); rollbackOk = true } catch {}
        // 只在链路损坏或 ROLLBACK 失败时销毁；业务错误（23505/40001/应用异常）健康归还
        if (!rollbackOk || isConnectionBroken(e)) client.release(e)
        else client.release()
      }
      const retryable = e.code === '40001' || isRetryableDatabaseError(e)
      if (!retryable || attempt >= 5) throw e
      // 退避量级必须覆盖 CRDB serverless 冷唤醒窗口（实测连续 4 次 ECONNRESET 后第 5 次才成功，
      // 累计需 ~11s）。序列化冲突用短退避即可，链路故障用长退避。
      const broken = e.code !== '40001'
      const base = broken ? 750 : 250
      const delay = Math.min(broken ? 8000 : 4000, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200)
      console.error(JSON.stringify({ evt: 'tx_retry', label, attempt, code: e.code }))
      await sleep(delay)
    }
  }
}

export const inSerializableTx = (fn, label) => runTxWithPool(getPool(), fn, label)
