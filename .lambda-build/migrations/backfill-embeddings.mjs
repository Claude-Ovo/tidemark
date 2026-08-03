// P0 local-onnx pivot backfill（结论 55 / Codex 六条边界 #1）：
// 把所有【带向量但身份缺失或过时】的行迁进当前 embedding 空间。
// - 模型调用全部在事务外；落库用 revision CAS（revision 变了 = 有人动过 -> 重读重试）
// - 每行 UPDATE 同时写 embedding + embedding_model_id 并 revision+1（结论 16 的 eligibility 语义）
// - 收尾验收：残留 count 必须为 0，否则非零退出——迁移不许"大概齐"
// 用法: EMBED_PROVIDER=local-onnx node --env-file=.env migrations/backfill-embeddings.mjs [--database tidemark_prod] [--dry-run]
import { connectWithRetry, withDatabase, validateDatabaseName } from './db.mjs'
import { embed, embedProviderName, embedModelId } from '../src/lib/embed.mjs'
import { toVectorLiteral } from '../src/lib/vector-canonical.mjs'

const args = process.argv.slice(2)
let database = process.env.TIDEMARK_DATABASE || 'tidemark_dev'
let dryRun = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--database') database = validateDatabaseName(args[++i] ?? '')
  else if (args[i] === '--dry-run') dryRun = true
  else throw new Error(`unknown argument: ${args[i]}`)
}
if (embedProviderName !== 'local-onnx') {
  throw new Error(`backfill must run with EMBED_PROVIDER=local-onnx (got "${embedProviderName}") - migrating INTO the stub space is never intended`)
}
const targetId = embedModelId()
console.log(`backfill target: ${database} -> identity ${targetId.slice(0, 60)}...`)

const db = await connectWithRetry(withDatabase(process.env.COCKROACH_DATABASE_URL, database), { label: 'backfill' })
try {
  const pending = () => db.query(
    `SELECT count(*)::INT AS n FROM memories
     WHERE embedding IS NOT NULL AND (embedding_model_id IS NULL OR embedding_model_id <> $1)`, [targetId])
  const before = (await pending()).rows[0].n
  console.log(`rows needing migration: ${before}`)
  if (dryRun || Number(before) === 0) {
    if (Number(before) !== 0) process.exitCode = 1
    console.log(dryRun ? 'dry-run done' : 'nothing to do; space is clean')
  } else {
    let migrated = 0, retried = 0
    for (;;) {
      const batch = (await db.query(
        `SELECT tenant_id, memory_id, content, revision FROM memories
         WHERE embedding IS NOT NULL AND (embedding_model_id IS NULL OR embedding_model_id <> $1)
         ORDER BY tenant_id, memory_id LIMIT 50`, [targetId])).rows
      if (batch.length === 0) break
      for (const row of batch) {
        const e = await embed(row.content)              // 事务外
        const r = await db.query(
          `UPDATE memories SET embedding = $3, embedding_model_id = $4, revision = revision + 1
           WHERE tenant_id = $1 AND memory_id = $2 AND revision = $5`,
          [row.tenant_id, row.memory_id, toVectorLiteral(e.f32), e.model_id, row.revision])
        if (r.rowCount === 1) migrated++
        else retried++                                   // revision CAS 失手：下一轮批次自然重读
      }
      console.log(`progress: migrated=${migrated} cas-retries=${retried}`)
    }
    const after = (await pending()).rows[0].n
    console.log(`done: migrated=${migrated}, residual=${after}`)
    if (Number(after) !== 0) { process.exitCode = 1; throw new Error(`backfill residual ${after} != 0`) }
  }
} finally { await db.end() }
