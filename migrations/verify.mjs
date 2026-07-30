import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { connectWithRetry, validateDatabaseName, withDatabase } from './db.mjs'

const DOMAIN_TABLES = [
  'memories',
  'attempt_events',
  'recall_requests',
  'outcomes',
  'tool_requests',
  'nightly_runs',
  'memory_derivations',
  'memory_event_evidence',
  'success_evidence',
  'memory_tombstones',
  'memory_rebuild_queue',
]

const parseArgs = (argv) => {
  let database
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--database') database = validateDatabaseName(argv[++i] ?? '')
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return { database }
}

const groupBy = (rows, keyFn) => {
  const groups = new Map()
  for (const row of rows) {
    const key = keyFn(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return groups
}

const vector512 = `[${Array(512).fill('0').join(',')}]`

const memoryInsert = (overrides = {}) => {
  const row = {
    tenant_id: 'verify_tenant',
    agent_id: 'verify_agent',
    memory_id: randomUUID(),
    layer: 'event',
    content: 'verify-only content',
    embedding: vector512,
    experience_body: null,
    exp_status: null,
    source: 'agent_inferred',
    admission: 'accepted',
    quarantine_expires_at: null,
    state: 'fresh',
    pinned: false,
    importance: 0.5,
    strength_anchor: 1,
    strength_anchor_at: new Date(),
    last_rewarded_at: new Date(),
    half_life_hours: 24,
    credited_success_count: 0,
    evidenced_blame_count: 0,
    revision: 0,
    ...overrides,
  }
  return {
    text: `INSERT INTO public.memories (
      tenant_id, agent_id, memory_id, layer, content, embedding, experience_body, exp_status,
      source, admission, quarantine_expires_at, state, pinned, importance, strength_anchor,
      strength_anchor_at, last_rewarded_at, half_life_hours, credited_success_count,
      evidenced_blame_count, revision
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::JSONB, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21
    )`,
    values: [
      row.tenant_id,
      row.agent_id,
      row.memory_id,
      row.layer,
      row.content,
      row.embedding,
      row.experience_body === null ? null : JSON.stringify(row.experience_body),
      row.exp_status,
      row.source,
      row.admission,
      row.quarantine_expires_at,
      row.state,
      row.pinned,
      row.importance,
      row.strength_anchor,
      row.strength_anchor_at,
      row.last_rewarded_at,
      row.half_life_hours,
      row.credited_success_count,
      row.evidenced_blame_count,
      row.revision,
    ],
    row,
  }
}

const nightlyRunInsert = (overrides = {}) => {
  const row = {
    tenant_id: 'verify_tenant',
    run_id: randomUUID(),
    job_kind: 'dream',
    scheduled_for: new Date(),
    pipeline_version: `verify-${randomUUID()}`,
    status: 'running',
    lease_expires_at: new Date(Date.now() + 60_000),
    attempt_count: 1,
    batch_size: 10,
    source_snapshot: [],
    source_fingerprint: randomBytes(32),
    ...overrides,
  }
  return {
    text: `INSERT INTO public.nightly_runs (
      tenant_id, run_id, job_kind, scheduled_for, pipeline_version, status,
      lease_expires_at, attempt_count, batch_size, source_snapshot, source_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11)`,
    values: [
      row.tenant_id,
      row.run_id,
      row.job_kind,
      row.scheduled_for,
      row.pipeline_version,
      row.status,
      row.lease_expires_at,
      row.attempt_count,
      row.batch_size,
      JSON.stringify(row.source_snapshot),
      row.source_fingerprint,
    ],
    row,
  }
}

const outcomeInsert = (overrides = {}) => {
  const row = {
    tenant_id: 'verify_tenant',
    outcome_request_id: `outcome-${randomUUID()}`,
    agent_id: 'verify_agent',
    episode_id: 'verify_episode',
    task_instance_id: `task-${randomUUID()}`,
    attempt_id: `attempt-${randomUUID()}`,
    status: 'success',
    attributions: [],
    plasticity_applied: false,
    ...overrides,
  }
  return {
    text: `INSERT INTO public.outcomes (
      tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id,
      attempt_id, status, attributions, plasticity_applied
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9)`,
    values: [
      row.tenant_id,
      row.outcome_request_id,
      row.agent_id,
      row.episode_id,
      row.task_instance_id,
      row.attempt_id,
      row.status,
      JSON.stringify(row.attributions),
      row.plasticity_applied,
    ],
    row,
  }
}

const attemptEventInsert = (overrides = {}) => {
  const row = {
    tenant_id: 'verify_tenant',
    agent_id: 'verify_agent',
    episode_id: 'verify_episode',
    task_instance_id: `task-${randomUUID()}`,
    attempt_id: `attempt-${randomUUID()}`,
    event_id: randomUUID(),
    event_type: 'note',
    ...overrides,
  }
  return {
    text: `INSERT INTO public.attempt_events (
      tenant_id, agent_id, episode_id, task_instance_id, attempt_id, event_id, event_type
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    values: [
      row.tenant_id,
      row.agent_id,
      row.episode_id,
      row.task_instance_id,
      row.attempt_id,
      row.event_id,
      row.event_type,
    ],
    row,
  }
}

const rebuildInsert = (overrides = {}) => {
  const row = {
    tenant_id: 'verify_tenant',
    agent_id: 'verify_agent',
    rebuild_id: randomUUID(),
    deleted_derived_memory_id: randomUUID(),
    remaining_source_memory_ids: [randomUUID()],
    originating_run_id: null,
    status: 'pending',
    attempt_count: 0,
    lease_expires_at: null,
    ...overrides,
  }
  return {
    text: `INSERT INTO public.memory_rebuild_queue (
      tenant_id, agent_id, rebuild_id, deleted_derived_memory_id,
      remaining_source_memory_ids, originating_run_id, status, attempt_count, lease_expires_at
    ) VALUES ($1, $2, $3, $4, $5::UUID[], $6, $7, $8, $9)`,
    values: [
      row.tenant_id,
      row.agent_id,
      row.rebuild_id,
      row.deleted_derived_memory_id,
      `{${row.remaining_source_memory_ids.join(',')}}`,
      row.originating_run_id,
      row.status,
      row.attempt_count,
      row.lease_expires_at,
    ],
    row,
  }
}

const checkCases = [
  ['memories_layer_ck', () => memoryInsert({ layer: 'invalid' })],
  ['memories_exp_body_iff_experience_ck', () => memoryInsert({ experience_body: { trigger: 'x' } })],
  ['memories_exp_status_iff_experience_ck', () => memoryInsert({ exp_status: 'candidate' })],
  ['memories_exp_status_ck', () => memoryInsert({ layer: 'experience', experience_body: { trigger: 'x' }, exp_status: 'invalid' })],
  ['memories_source_ck', () => memoryInsert({ source: 'agent_forged' })],
  ['memories_admission_ck', () => memoryInsert({ admission: 'invalid', embedding: null })],
  ['memories_state_ck', () => memoryInsert({ state: 'invalid' })],
  ['memories_importance_ck', () => memoryInsert({ importance: 1.1 })],
  ['memories_strength_anchor_ck', () => memoryInsert({ strength_anchor: -0.1 })],
  ['memories_half_life_ck', () => memoryInsert({ half_life_hours: 0 })],
  ['memories_credited_count_ck', () => memoryInsert({ credited_success_count: -1 })],
  ['memories_blame_count_ck', () => memoryInsert({ evidenced_blame_count: -1 })],
  ['memories_quarantine_expiry_ck', () => memoryInsert({ admission: 'quarantined', embedding: null })],
  ['memories_accepted_embedding_ck', () => memoryInsert({ embedding: null })],
  ['memories_quarantined_no_embedding_ck', () => memoryInsert({ admission: 'quarantined', quarantine_expires_at: new Date(Date.now() + 60_000) })],
  ['memories_pin_accepted_ck', () => memoryInsert({ admission: 'quarantined', embedding: null, quarantine_expires_at: new Date(Date.now() + 60_000), pinned: true })],
  ['attempt_events_event_type_ck', () => attemptEventInsert({ event_type: 'invalid' })],
  ['recall_requests_outcome_state_ck', () => ({
    text: `INSERT INTO public.recall_requests (
      tenant_id, request_id, agent_id, attempt_id, query_hmac, pipeline_version,
      outcome_state, receipt_json, serialization_checksum
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9)`,
    values: ['verify_tenant', `recall-${randomUUID()}`, 'verify_agent', 'attempt', randomBytes(32), 'verify', 'invalid', '{}', randomBytes(32)],
  })],
  ['outcomes_status_ck', () => outcomeInsert({ status: 'invalid' })],
  ['tool_requests_tool_name_ck', () => ({
    text: `INSERT INTO public.tool_requests (
      tenant_id, agent_id, tool_name, request_id, payload_hmac, response_json
    ) VALUES ($1, $2, $3, $4, $5, $6::JSONB)`,
    values: ['verify_tenant', 'verify_agent', 'invalid', randomUUID(), randomBytes(32), '{}'],
  })],
  ['nightly_runs_job_kind_ck', () => nightlyRunInsert({ job_kind: 'invalid' })],
  ['nightly_runs_status_ck', () => nightlyRunInsert({ status: 'invalid' })],
  ['nightly_runs_attempt_count_ck', () => nightlyRunInsert({ attempt_count: 0 })],
  ['nightly_runs_batch_size_ck', () => nightlyRunInsert({ batch_size: 0 })],
  ['nightly_runs_running_lease_ck', () => nightlyRunInsert({ lease_expires_at: null })],
  ['memory_derivations_no_self_ck', () => {
    const id = randomUUID()
    return {
      text: 'INSERT INTO public.memory_derivations (tenant_id, derived_memory_id, source_memory_id, run_id) VALUES ($1, $2, $2, $3)',
      values: ['verify_tenant', id, randomUUID()],
    }
  }],
  ['memory_rebuild_queue_status_ck', () => rebuildInsert({ status: 'invalid' })],
  ['memory_rebuild_queue_attempt_count_ck', () => rebuildInsert({ attempt_count: -1 })],
  ['memory_rebuild_queue_processing_lease_ck', () => rebuildInsert({ status: 'processing', lease_expires_at: null })],
]

const expectViolation = async (client, {
  name,
  operation,
  setup = [],
  expectedCode,
  expectedConstraint,
}) => {
  await client.query('BEGIN')
  let violation
  try {
    for (const query of setup) await client.query(query)
    try {
      await client.query(operation)
    } catch (error) {
      violation = error
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
  }
  assert.ok(violation, `${name}: violating statement unexpectedly succeeded`)
  assert.equal(violation.code, expectedCode, `${name}: expected SQLSTATE ${expectedCode}, got ${violation.code}: ${violation.message}`)
  if (expectedConstraint) {
    const detail = `${violation.constraint ?? ''} ${violation.message}`
    assert.ok(detail.includes(expectedConstraint), `${name}: expected constraint ${expectedConstraint}, got ${detail}`)
  }
  console.log(`PASS ${name}`)
}

const auditSchema = async (client) => {
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  `)
  const actualTables = new Set(tables.rows.map(row => row.table_name))
  for (const table of [...DOMAIN_TABLES, 'schema_migrations']) {
    assert.ok(actualTables.has(table), `missing table ${table}`)
  }

  const primaryKeyColumns = await client.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_catalog = kcu.constraint_catalog
     AND tc.constraint_schema = kcu.constraint_schema
     AND tc.constraint_name = kcu.constraint_name
    WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY tc.table_name, kcu.ordinal_position
  `)
  const primaryKeys = groupBy(primaryKeyColumns.rows, row => row.table_name)
  for (const table of DOMAIN_TABLES) {
    const columns = (primaryKeys.get(table) ?? []).map(row => row.column_name)
    assert.ok(columns.includes('tenant_id'), `${table} primary key is not tenant-scoped: ${columns.join(',')}`)
  }

  const foreignKeyColumns = await client.query(`
    SELECT tc.table_name, tc.constraint_name, kcu.column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_catalog = kcu.constraint_catalog
     AND tc.constraint_schema = kcu.constraint_schema
     AND tc.constraint_name = kcu.constraint_name
    WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
  `)
  const foreignKeys = groupBy(foreignKeyColumns.rows, row => `${row.table_name}.${row.constraint_name}`)
  for (const [name, rows] of foreignKeys) {
    const columns = rows.map(row => row.column_name)
    assert.ok(columns.includes('tenant_id'), `${name} is not tenant-scoped: ${columns.join(',')}`)
  }

  const checkConstraints = await client.query(`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema() AND constraint_type = 'CHECK'
  `)
  const actualChecks = new Set(checkConstraints.rows.map(row => row.constraint_name))
  const testedChecks = new Set(checkCases.map(([name]) => name))
  assert.deepEqual(
    [...actualChecks].filter(name => DOMAIN_TABLES.some(table => name.startsWith(`${table}_`)) && !testedChecks.has(name)),
    [],
    'domain CHECK constraints exist without a negative test',
  )
  for (const name of testedChecks) assert.ok(actualChecks.has(name), `negative test references missing CHECK ${name}`)

  const embeddingColumn = await client.query(`
    SELECT crdb_sql_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'memories' AND column_name = 'embedding'
  `)
  assert.equal(embeddingColumn.rowCount, 1, 'missing memories.embedding')
  assert.equal(embeddingColumn.rows[0].crdb_sql_type, 'VECTOR(512)')
  assert.equal(embeddingColumn.rows[0].is_nullable, 'YES')

  const memoryIndexes = await client.query(`
    SELECT DISTINCT index_name
    FROM information_schema.statistics
    WHERE table_schema = current_schema() AND table_name = 'memories'
  `)
  const actualIndexes = new Set(memoryIndexes.rows.map(row => row.index_name))
  for (const index of ['mem_vec_idx', 'mem_due_idx', 'mem_pin_idx', 'memories_tenant_memory_uq']) {
    assert.ok(actualIndexes.has(index), `missing memories index ${index}`)
  }

  console.log(`PASS schema audit (${DOMAIN_TABLES.length} tenant-scoped PKs, ${foreignKeys.size} tenant-scoped FKs, ${testedChecks.size} explicit CHECKs, 4 memory indexes)`)
}

const runCheckTests = async (client) => {
  for (const [constraint, makeOperation] of checkCases) {
    await expectViolation(client, {
      name: `CHECK ${constraint}`,
      operation: makeOperation(),
      expectedCode: '23514',
      expectedConstraint: constraint,
    })
  }
}

const runUniqueTests = async (client) => {
  const firstOutcome = outcomeInsert()
  const duplicateAttempt = outcomeInsert({
    tenant_id: firstOutcome.row.tenant_id,
    attempt_id: firstOutcome.row.attempt_id,
  })
  await expectViolation(client, {
    name: 'UNIQUE outcomes (tenant_id, attempt_id)',
    setup: [firstOutcome],
    operation: duplicateAttempt,
    expectedCode: '23505',
    expectedConstraint: 'outcomes_attempt_uq',
  })

  const firstRun = nightlyRunInsert()
  const duplicateSchedule = nightlyRunInsert({
    tenant_id: firstRun.row.tenant_id,
    job_kind: firstRun.row.job_kind,
    scheduled_for: firstRun.row.scheduled_for,
    pipeline_version: firstRun.row.pipeline_version,
  })
  await expectViolation(client, {
    name: 'UNIQUE nightly schedule key',
    setup: [firstRun],
    operation: duplicateSchedule,
    expectedCode: '23505',
    expectedConstraint: 'nightly_runs_schedule_uq',
  })

  const duplicateFingerprint = nightlyRunInsert({
    tenant_id: firstRun.row.tenant_id,
    job_kind: firstRun.row.job_kind,
    scheduled_for: new Date(firstRun.row.scheduled_for.getTime() + 60_000),
    pipeline_version: firstRun.row.pipeline_version,
    source_fingerprint: firstRun.row.source_fingerprint,
  })
  await expectViolation(client, {
    name: 'UNIQUE nightly source fingerprint',
    setup: [firstRun],
    operation: duplicateFingerprint,
    expectedCode: '23505',
    expectedConstraint: 'nightly_runs_fingerprint_uq',
  })
}

const runForeignKeyTests = async (client) => {
  {
    const sourceA = memoryInsert({ tenant_id: 'tenant_a' })
    const derivedA = memoryInsert({ tenant_id: 'tenant_a' })
    const runB = nightlyRunInsert({ tenant_id: 'tenant_b' })
    await expectViolation(client, {
      name: 'FK derivation cannot cross tenant',
      setup: [sourceA, derivedA, runB],
      operation: {
        text: 'INSERT INTO public.memory_derivations (tenant_id, derived_memory_id, source_memory_id, run_id) VALUES ($1, $2, $3, $4)',
        values: ['tenant_b', derivedA.row.memory_id, sourceA.row.memory_id, runB.row.run_id],
      },
      expectedCode: '23503',
      expectedConstraint: 'memory_derivations_derived_fk',
    })
  }

  {
    const memoryA = memoryInsert({ tenant_id: 'tenant_a' })
    const eventA = attemptEventInsert({ tenant_id: 'tenant_a' })
    const runB = nightlyRunInsert({ tenant_id: 'tenant_b', job_kind: 'reflection' })
    await expectViolation(client, {
      name: 'FK reflection evidence cannot cross tenant',
      setup: [memoryA, eventA, runB],
      operation: {
        text: `INSERT INTO public.memory_event_evidence (
          tenant_id, derived_memory_id, attempt_id, event_id, run_id
        ) VALUES ($1, $2, $3, $4, $5)`,
        values: ['tenant_b', memoryA.row.memory_id, eventA.row.attempt_id, eventA.row.event_id, runB.row.run_id],
      },
      expectedCode: '23503',
      expectedConstraint: 'memory_event_evidence_memory_fk',
    })
  }

  {
    const experienceA = memoryInsert({
      tenant_id: 'tenant_a',
      layer: 'experience',
      experience_body: { trigger: 'x', wrong_action: 'y', correct_action: 'z', caution: 'c', evidence_ids: [] },
      exp_status: 'candidate',
    })
    const outcomeB = outcomeInsert({ tenant_id: 'tenant_b' })
    await expectViolation(client, {
      name: 'FK success evidence cannot cross tenant',
      setup: [experienceA, outcomeB],
      operation: {
        text: `INSERT INTO public.success_evidence (
          tenant_id, experience_id, task_instance_id, outcome_request_id
        ) VALUES ($1, $2, $3, $4)`,
        values: ['tenant_b', experienceA.row.memory_id, outcomeB.row.task_instance_id, outcomeB.row.outcome_request_id],
      },
      expectedCode: '23503',
      expectedConstraint: 'success_evidence_memory_fk',
    })
  }

  {
    const runA = nightlyRunInsert({ tenant_id: 'tenant_a' })
    const queueB = rebuildInsert({ tenant_id: 'tenant_b', originating_run_id: runA.row.run_id })
    await expectViolation(client, {
      name: 'FK rebuild queue run cannot cross tenant',
      setup: [runA],
      operation: queueB,
      expectedCode: '23503',
      expectedConstraint: 'memory_rebuild_queue_run_fk',
    })
  }
}

const runPositiveProvenanceTest = async (client) => {
  const tenantId = 'verify_tenant'
  const source = memoryInsert({ tenant_id: tenantId })
  const dream = memoryInsert({ tenant_id: tenantId, source: 'derived' })
  const experience = memoryInsert({
    tenant_id: tenantId,
    layer: 'experience',
    source: 'derived',
    experience_body: { trigger: 'x', wrong_action: 'y', correct_action: 'z', caution: 'c', evidence_ids: [] },
    exp_status: 'candidate',
  })
  const dreamRun = nightlyRunInsert({ tenant_id: tenantId, job_kind: 'dream' })
  const reflectionRun = nightlyRunInsert({ tenant_id: tenantId, job_kind: 'reflection' })
  const event = attemptEventInsert({ tenant_id: tenantId, event_type: 'tool_error' })
  const outcome = outcomeInsert({
    tenant_id: tenantId,
    task_instance_id: event.row.task_instance_id,
    attempt_id: event.row.attempt_id,
    status: 'success',
  })
  const rebuild = rebuildInsert({
    tenant_id: tenantId,
    deleted_derived_memory_id: dream.row.memory_id,
    remaining_source_memory_ids: [source.row.memory_id],
    originating_run_id: dreamRun.row.run_id,
  })

  await client.query('BEGIN')
  try {
    for (const query of [source, dream, experience, dreamRun, reflectionRun, event, outcome]) {
      await client.query(query)
    }
    await client.query({
      text: 'INSERT INTO public.memory_derivations (tenant_id, derived_memory_id, source_memory_id, run_id) VALUES ($1, $2, $3, $4)',
      values: [tenantId, dream.row.memory_id, source.row.memory_id, dreamRun.row.run_id],
    })
    await client.query({
      text: `INSERT INTO public.memory_event_evidence (
        tenant_id, derived_memory_id, attempt_id, event_id, run_id
      ) VALUES ($1, $2, $3, $4, $5)`,
      values: [tenantId, experience.row.memory_id, event.row.attempt_id, event.row.event_id, reflectionRun.row.run_id],
    })
    await client.query({
      text: `INSERT INTO public.success_evidence (
        tenant_id, experience_id, task_instance_id, outcome_request_id
      ) VALUES ($1, $2, $3, $4)`,
      values: [tenantId, experience.row.memory_id, outcome.row.task_instance_id, outcome.row.outcome_request_id],
    })
    await client.query(rebuild)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
  }
  console.log('PASS same-tenant provenance/evidence/rebuild graph inserts')
}

const assertNoVerifyRows = async (client) => {
  for (const table of DOMAIN_TABLES) {
    const result = await client.query(`SELECT count(*)::INT AS count FROM public.${table} WHERE tenant_id LIKE 'verify_%'`)
    assert.equal(Number(result.rows[0].count), 0, `${table} retained verify rows`)
  }
  console.log('PASS verification transactions left zero rows')
}

const main = async () => {
  const baseConnectionString = process.env.COCKROACH_DATABASE_URL
  if (!baseConnectionString) throw new Error('missing COCKROACH_DATABASE_URL')
  // resolution order matches the service layer: --database > TIDEMARK_DATABASE > tidemark_dev
  const database = parseArgs(process.argv.slice(2)).database
    ?? validateDatabaseName(process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  const targetConnectionString = withDatabase(baseConnectionString, database)
  const client = await connectWithRetry(targetConnectionString, { label: database })
  try {
    await auditSchema(client)
    await runCheckTests(client)
    await runUniqueTests(client)
    await runPositiveProvenanceTest(client)
    await runForeignKeyTests(client)
    await assertNoVerifyRows(client)
    console.log(`ALL MIGRATION VERIFICATIONS PASSED (${checkCases.length} CHECK negatives)`)
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch(error => {
  console.error(`verification failed: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
