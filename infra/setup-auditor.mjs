// P0-10：审计只读账号开户/轮换（幂等）。结论 18/25：Managed MCP 是 operator-facing
// 审计路径，凭据只配这个 auditor 账号——SELECT 限于三张脱敏视图 + 九张"永无散文"表，
// 基表 memories/recall_requests/nightly_runs 无任何授权，写操作全库无授权。
// 用法:
//   TIDEMARK_AUDITOR_PASSWORD=... node --env-file=.env infra/setup-auditor.mjs --database tidemark_dev
//   node --env-file=.env infra/setup-auditor.mjs --database tidemark_prod --store-secret   （自动生成并存 Secrets Manager tidemark/auditor）
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectWithRetry, withDatabase, validateDatabaseName, quoteIdentifier } from '../migrations/db.mjs'

const AUDITOR = 'tidemark_auditor'
// SELECT 面（唯一授权面）：脱敏视图 x3 + 写入卫生已冻结的 content-free 表 x9
export const AUDIT_RELATIONS = [
  'audit_memories', 'audit_recalls', 'audit_nightly_runs', 'audit_memory_rebuild_queue',
  'attempt_events', 'outcomes', 'memory_derivations', 'memory_event_evidence',
  'reflection_pairs', 'memory_tombstones', 'success_evidence', 'reflection_cursor',
]

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
const args = process.argv.slice(2)
let database = process.env.TIDEMARK_DATABASE || 'tidemark_dev'
let storeSecret = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--database') database = validateDatabaseName(args[++i] ?? '')
  else if (args[i] === '--store-secret') storeSecret = true
  else throw new Error(`unknown argument: ${args[i]}`)
}
const password = process.env.TIDEMARK_AUDITOR_PASSWORD || randomBytes(24).toString('base64url')
if (!process.env.TIDEMARK_AUDITOR_PASSWORD && !storeSecret) {
  throw new Error('generated password would be lost: pass TIDEMARK_AUDITOR_PASSWORD or --store-secret')
}

const c = await connectWithRetry(withDatabase(process.env.COCKROACH_DATABASE_URL, database), { label: 'setup-auditor' })
try {
  await c.query(`CREATE USER IF NOT EXISTS ${AUDITOR}`)
  // CRDB 默认把 schema 的 CREATE 留给 public 角色——任何新用户都能建表（A3 实测抓获）。
  // 审计库里这权限对谁都不该存在：从 public 角色收回，auditor 只留 USAGE
  await c.query(`REVOKE CREATE ON SCHEMA public FROM public`)
  await c.query(`REVOKE ALL ON SCHEMA public FROM ${AUDITOR}`)
  await c.query(`GRANT USAGE ON SCHEMA public TO ${AUDITOR}`)
  // 密码经参数占位不可用于 DDL：走受控字符串拼接前先严格校验字符集（base64url 或显式传入）
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new Error('auditor password must be >=16 chars of [A-Za-z0-9_-]')
  await c.query(`ALTER USER ${AUDITOR} WITH PASSWORD '${password}'`)
  await c.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${AUDITOR}`)
  for (const rel of AUDIT_RELATIONS) {
    await c.query(`GRANT SELECT ON TABLE public.${quoteIdentifier(rel)} TO ${AUDITOR}`)
  }
  // 收敛面（round-2 P1-2 重做）：以 SHOW GRANTS FOR 的【全限定四元组】为准——
  // database/schema/relation 三层全覆盖，schema 不再被吞；清单外任何 privilege 按其
  // 真实 schema 精确 REVOKE（不再想当然拼 public.<name>）。role 继承与 role option
  // 同步收敛：显式 membership 一律撤销，危险 option 显式关闭。
  const allowed = (dbn, sch, rel, priv) =>
    (rel === null && sch === null && priv === 'CONNECT' && dbn === database) ||
    (rel === null && sch === 'public' && priv === 'USAGE') ||
    (sch === 'public' && rel !== null && AUDIT_RELATIONS.includes(rel) && priv === 'SELECT')
  const grants = (await c.query(`SHOW GRANTS FOR ${AUDITOR}`)).rows
  for (const g of grants) {
    if (g.grantee !== AUDITOR) continue   // SHOW GRANTS FOR 也回带 public 角色继承行，不归我们撤
    const dbn = g.database_name ?? null
    const sch = g.schema_name ?? null
    const rel = g.object_name ?? g.relation_name ?? null
    const priv = g.privilege_type
    if (allowed(dbn, sch, rel, priv)) continue
    if (rel !== null) {
      await c.query(`REVOKE ${priv} ON TABLE ${quoteIdentifier(sch ?? 'public')}.${quoteIdentifier(rel)} FROM ${AUDITOR}`)
      console.log(`revoked drifted grant: ${priv} on ${sch}.${rel}`)
    } else if (sch !== null) {
      await c.query(`REVOKE ${priv} ON SCHEMA ${quoteIdentifier(sch)} FROM ${AUDITOR}`)
      console.log(`revoked drifted schema grant: ${priv} on ${sch}`)
    } else if (dbn !== null) {
      await c.query(`REVOKE ${priv} ON DATABASE ${quoteIdentifier(dbn)} FROM ${AUDITOR}`)
      console.log(`revoked drifted database grant: ${priv} on ${dbn}`)
    }
  }
  // role 继承：auditor 不许是任何角色的成员（public 隐式成员除外，系统不允许撤）
  const memberships = (await c.query(`SHOW GRANTS ON ROLE`)).rows
    .filter(m => (m.member ?? m.grantee) === AUDITOR)
  for (const m of memberships) {
    const role = m.role_name ?? m.role
    await c.query(`REVOKE ${quoteIdentifier(role)} FROM ${AUDITOR}`)
    console.log(`revoked drifted role membership: ${role}`)
  }
  // 危险 role option 显式关闭（幂等）
  await c.query(`ALTER USER ${AUDITOR} WITH NOCREATEROLE NOCREATEDB NOCONTROLJOB NOMODIFYCLUSTERSETTING`)
  console.log(`auditor ready on ${database}: SELECT on ${AUDIT_RELATIONS.length} relations, nothing else`)

  if (storeSecret) {
    const aws = process.env.AWS_CLI_PATH || 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
    const payload = JSON.stringify({ user: AUDITOR, password, database, note: 'read-only audit account for Managed MCP (P0-10)' })
    const dir = mkdtempSync(join(tmpdir(), 'auditor-secret-'))
    const f = join(dir, 'payload.json')
    try {
      writeFileSync(f, payload)
      const fileArg = 'file://' + f.replace(/\\/g, '/')
      try {
        execFileSync(aws, ['secretsmanager', 'create-secret', '--name', 'tidemark/auditor', '--secret-string', fileArg], { stdio: 'pipe' })
        console.log('secret created: tidemark/auditor')
      } catch {
        execFileSync(aws, ['secretsmanager', 'put-secret-value', '--secret-id', 'tidemark/auditor', '--secret-string', fileArg], { stdio: 'pipe' })
        console.log('secret rotated: tidemark/auditor')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
} finally { await c.end() }
}
