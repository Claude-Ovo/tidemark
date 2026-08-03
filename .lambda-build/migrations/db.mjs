import pg from 'pg'

const RETRYABLE_CODES = new Set([
  '40001',
  '53300',
  '57P01',
  '08000',
  '08001',
  '08003',
  '08006',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
])

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export const isRetryableDatabaseError = (error) =>
  RETRYABLE_CODES.has(error?.code) || /connection.*(closed|terminated|reset)/i.test(error?.message ?? '')

export const validateDatabaseName = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`invalid database name "${name}" (expected lowercase letters, digits, underscore)`)
  }
  return name
}

export const quoteIdentifier = (identifier) => `"${identifier.replaceAll('"', '""')}"`

export const withDatabase = (connectionString, databaseName) => {
  validateDatabaseName(databaseName)
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

export const connectWithRetry = async (connectionString, { attempts = 5, label = 'database' } = {}) => {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 })
    try {
      await client.connect()
      await client.query('SET search_path = public')
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => {})
      if (!isRetryableDatabaseError(error) || attempt === attempts) throw error
      const delayMs = Math.min(8000, 750 * (2 ** (attempt - 1)))
      console.error(`[retry] ${label} connect ${attempt}/${attempts} failed (${error.code ?? 'unknown'}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
    }
  }
  throw lastError
}
