// 一次性随机库的生命周期封装（Codex P0-05 round-6：CREATE、首次 connect、fn 必须
// 同处最外层 try——首次连接失败也要走 cleanup，否则 CREATE 成功+connect 风暴=库残留）。
// connect 可注入：单测用 fake 断言"connect 抛错仍恰好 DROP 一次、且只 DROP 本次建的库"。
import { quoteIdentifier, withDatabase } from './db.mjs'

export const withDisposableDb = async ({ base, mkName, connect, fn, log = console }) => {
  const DB = mkName()
  let created = false
  let client = null
  try {
    const admin = await connect(base, { label: 'admin' })
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(DB)}`)   // 无 IF NOT EXISTS：撞名 fail-closed
      created = true
    } finally { await admin.end().catch(() => {}) }
    client = await connect(withDatabase(base, DB), { label: DB })
    return await fn(client)
  } finally {
    await client?.end().catch(() => {})
    if (created) {
      try {
        const admin2 = await connect(base, { label: 'admin-cleanup' })
        try {
          await admin2.query(`DROP DATABASE ${quoteIdentifier(DB)} CASCADE`)
          log.log(`disposable db dropped: ${DB}`)
        } finally { await admin2.end().catch(() => {}) }
      } catch (e) {
        // 不吞主错误：报告残留并置退出码，人工按库名清理
        log.error(`CLEANUP FAILED: disposable db ${DB} still exists: ${e.message}`)
        process.exitCode = 1
      }
    }
  }
}
