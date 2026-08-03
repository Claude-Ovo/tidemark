import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  connectWithRetry,
  isRetryableDatabaseError,
  quoteIdentifier,
  sleep,
  validateDatabaseName,
  withDatabase,
} from './db.mjs'
import { PREFLIGHTS } from './preflights.mjs'

const MIGRATION_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/
const migrationsDir = path.dirname(fileURLToPath(import.meta.url))

const parseArgs = (argv) => {
  let database
  let createDatabase = false
  let through = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--database') {
      database = validateDatabaseName(argv[++i] ?? '')
    } else if (argv[i] === '--create-database') {
      createDatabase = true
    } else if (argv[i] === '--through') {
      // maintenance cutover support (conclusion 55 / local-onnx round-2 P0): apply only
      // migrations with version <= N, so operators can sequence 034 -> deploy new
      // writers -> backfill -> rest. Format: three digits, must match an existing file.
      const v = argv[++i] ?? ''
      if (!/^\d{3}$/.test(v)) throw new Error(`--through expects a three-digit version, got "${v}"`)
      through = Number(v)
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (createDatabase && !database) throw new Error('--create-database requires --database <name>')
  return { database, createDatabase, through }
}

const normalizeSql = (sql) => sql.replaceAll('\r\n', '\n').trim()

const assertSingleStatement = (sql, filename) => {
  const withoutTrailingSemicolon = sql.endsWith(';') ? sql.slice(0, -1) : sql
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error(`${filename} must contain exactly one schema-change statement`)
  }
}

const checksum = (sql) => createHash('sha256').update(sql).digest('hex')

export const loadMigrations = async () => {
  const filenames = (await readdir(migrationsDir)).filter(name => MIGRATION_PATTERN.test(name)).sort()
  const versions = new Set()
  const migrations = []
  for (const filename of filenames) {
    const match = filename.match(MIGRATION_PATTERN)
    const version = Number(match[1])
    if (versions.has(version)) throw new Error(`duplicate migration version ${match[1]}`)
    versions.add(version)
    const sql = normalizeSql(await readFile(path.join(migrationsDir, filename), 'utf8'))
    assertSingleStatement(sql, filename)
    migrations.push({ version, filename, sql, checksum: checksum(sql) })
  }
  if (migrations.length === 0) throw new Error('no migration files found')
  return migrations
}

export const ensureMigrationLedger = (client) => client.query(`
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version INT8 NOT NULL,
    filename STRING NOT NULL,
    checksum STRING NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (version),
    UNIQUE INDEX schema_migrations_filename_uq (filename)
  )
`)

const readApplied = async (client, version) => {
  const result = await client.query(
    'SELECT filename, checksum FROM public.schema_migrations WHERE version = $1',
    [version],
  )
  return result.rows[0] ?? null
}

const assertAppliedMatches = (migration, applied) => {
  if (applied.filename !== migration.filename || applied.checksum !== migration.checksum) {
    throw new Error(
      `migration ${migration.version} checksum/name mismatch: database has ${applied.filename} ${applied.checksum}, file has ${migration.filename} ${migration.checksum}`,
    )
  }
}

export const applyOne = async (client, migration) => {
  const existing = await readApplied(client, migration.version)
  if (existing) {
    assertAppliedMatches(migration, existing)
    return 'already'
  }

  // fail-closed guard for destructive migrations: a throw aborts the run with
  // manual instructions instead of silently destroying data (see preflights.mjs)
  const preflight = PREFLIGHTS[migration.version]
  if (preflight) await preflight(client)

  // CockroachDB does not guarantee atomic rollback for multiple schema changes in
  // one explicit transaction. Each file is one idempotent autocommit statement;
  // the ledger write follows it and can be safely repaired by a rerun.
  await client.query(migration.sql)
  try {
    await client.query(
      'INSERT INTO public.schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.filename, migration.checksum],
    )
    return 'applied'
  } catch (error) {
    if (error.code !== '23505') throw error
    const winner = await readApplied(client, migration.version)
    if (!winner) throw error
    assertAppliedMatches(migration, winner)
    return 'concurrent'
  }
}

const main = async () => {
  const baseConnectionString = process.env.COCKROACH_DATABASE_URL
  if (!baseConnectionString) throw new Error('missing COCKROACH_DATABASE_URL')
  const parsed = parseArgs(process.argv.slice(2))
  // resolution order matches the service layer: --database > TIDEMARK_DATABASE > tidemark_dev
  const database = parsed.database
    ?? validateDatabaseName(process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  const { createDatabase } = parsed

  if (createDatabase) {
    const admin = await connectWithRetry(baseConnectionString, { label: 'admin database' })
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}`)
      console.log(`database ready: ${database}`)
    } finally {
      await admin.end().catch(() => {})
    }
  }

  const targetConnectionString = database ? withDatabase(baseConnectionString, database) : baseConnectionString
  let migrations = await loadMigrations()
  if (parsed.through !== null) {
    if (!migrations.some(m => m.version === parsed.through)) {
      throw new Error(`--through ${String(parsed.through).padStart(3, '0')} does not match any migration file`)
    }
    migrations = migrations.filter(m => m.version <= parsed.through)
    console.log(`applying through ${String(parsed.through).padStart(3, '0')} (${migrations.length} files considered)`)
  }
  let client = await connectWithRetry(targetConnectionString, { label: database ?? 'configured database' })

  const reconnect = async () => {
    await client?.end().catch(() => {})
    client = await connectWithRetry(targetConnectionString, { label: database ?? 'configured database' })
  }

  const runWithRetry = async (operation, label) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await operation()
      } catch (error) {
        if (!isRetryableDatabaseError(error) || attempt === 5) throw error
        const delayMs = Math.min(8000, 500 * (2 ** (attempt - 1)))
        console.error(`[retry] ${label} ${attempt}/5 failed (${error.code ?? 'unknown'}); reconnecting in ${delayMs}ms`)
        await sleep(delayMs)
        await reconnect()
      }
    }
  }

  try {
    await runWithRetry(() => ensureMigrationLedger(client), 'schema_migrations')
    for (const migration of migrations) {
      const result = await runWithRetry(() => applyOne(client, migration), migration.filename)
      console.log(`${result.padEnd(10)} ${migration.filename}`)
    }
    console.log(`migrations complete: ${migrations.length} files`)
  } finally {
    await client?.end().catch(() => {})
  }
}

// CLI 入口守卫：被集成测试 import 导出函数时绝不能触发整轮 migrate
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`migration failed: ${error.message}`)
    process.exitCode = 1
  })
}
