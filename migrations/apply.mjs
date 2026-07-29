import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectWithRetry,
  isRetryableDatabaseError,
  quoteIdentifier,
  sleep,
  validateDatabaseName,
  withDatabase,
} from './db.mjs'

const MIGRATION_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/
const migrationsDir = path.dirname(fileURLToPath(import.meta.url))

const parseArgs = (argv) => {
  let database
  let createDatabase = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--database') {
      database = validateDatabaseName(argv[++i] ?? '')
    } else if (argv[i] === '--create-database') {
      createDatabase = true
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (createDatabase && !database) throw new Error('--create-database requires --database <name>')
  return { database, createDatabase }
}

const normalizeSql = (sql) => sql.replaceAll('\r\n', '\n').trim()

const assertSingleStatement = (sql, filename) => {
  const withoutTrailingSemicolon = sql.endsWith(';') ? sql.slice(0, -1) : sql
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error(`${filename} must contain exactly one schema-change statement`)
  }
}

const checksum = (sql) => createHash('sha256').update(sql).digest('hex')

const loadMigrations = async () => {
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

const ensureMigrationLedger = (client) => client.query(`
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

const applyOne = async (client, migration) => {
  const existing = await readApplied(client, migration.version)
  if (existing) {
    assertAppliedMatches(migration, existing)
    return 'already'
  }

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
  const { database, createDatabase } = parseArgs(process.argv.slice(2))

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
  const migrations = await loadMigrations()
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

main().catch(error => {
  console.error(`migration failed: ${error.message}`)
  process.exitCode = 1
})
