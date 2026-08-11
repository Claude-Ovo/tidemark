// Adds a read-only viz-scope key to the production secret (idempotent).
//
// The public demo URL needs a credential that CloudFront can inject as an origin
// custom header. That credential must be scope='viz': the tool face nulls it out
// (toolPrincipal in src/server.mjs), so leaking it from the CDN config exposes
// nothing but the already-public read-only visualization endpoints.
//
// Usage: node infra/add-viz-key.mjs [--secret-id tidemark/prod] [--region us-east-1]
//        [--tenant demo-tenant] [--agent demo-agent] [--print-key]
import { randomBytes } from 'node:crypto'
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? dflt
const SECRET_ID = arg('secret-id', 'tidemark/prod')
const REGION = arg('region', 'us-east-1')
const TENANT = arg('tenant', 'demo-tenant')
const AGENT = arg('agent', 'demo-agent')
const PRINT = process.argv.includes('--print-key')
// --quiet: emit only the bare key on stdout, so deploy scripts can capture it
// without parsing JSON across a shell boundary.
const QUIET = process.argv.includes('--quiet')
const emit = (payload, key) => {
  if (QUIET) process.stdout.write(key)
  else console.log(JSON.stringify(payload))
}

const client = new SecretsManagerClient({ region: REGION })
const current = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))
const secret = JSON.parse(current.SecretString)
const keys = JSON.parse(secret.TIDEMARK_AGENT_KEYS ?? '{}')

const existing = Object.entries(keys).find(([, v]) => v && v.scope === 'viz')
if (existing) {
  emit({ ok: true, action: 'unchanged', reason: 'viz key already present',
    key: PRINT ? existing[0] : `${existing[0].slice(0, 12)}...`, principal: existing[1] }, existing[0])
  process.exit(0)
}

// Read-only face: no capabilities, scope viz. Never grant memory:pin here.
const key = `tk_viz_${randomBytes(24).toString('base64url')}`
keys[key] = { tenant_id: TENANT, agent_id: AGENT, capabilities: [], scope: 'viz' }
secret.TIDEMARK_AGENT_KEYS = JSON.stringify(keys)
await client.send(new PutSecretValueCommand({ SecretId: SECRET_ID, SecretString: JSON.stringify(secret) }))

emit({ ok: true, action: 'added',
  key: PRINT ? key : `${key.slice(0, 12)}...`,
  principal: keys[key],
  note: 'Lambda picks this up on the next cold start; update the CloudFront origin custom header with the full key.' }, key)
