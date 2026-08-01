// P0-09 线上 smoke（验收：完整线上闭环 + 重复 EventBridge 触发只提交一次 + 仓库无 secret）
// 用法: node --env-file=.env infra/smoke.mjs <api-base-url>
// 凭据来源：agent/admin key 从 Secrets Manager 现取（本地 aws 凭据），不落盘不进 argv；
// DB 断言直连 CRDB tidemark_prod（.env 的集群 URL）。S1-S10 走公网 API Gateway，
// S11 用 aws cli 以同一 canonical scheduled_for 连续 invoke 夜间函数两次，再到
// nightly_runs 数行证明 (tenant, job_kind, scheduled_for, pipeline_version) 恰好各一行。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { withDatabase, connectWithRetry } from '../migrations/db.mjs'

const url = process.argv[2]
assert.ok(url, 'usage: node --env-file=.env infra/smoke.mjs <api-base-url>')
const AWS_CLI = process.env.AWS_CLI_PATH || 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
const PROD_DB = 'tidemark_prod'

// ---- 凭据：从 tidemark/prod secret 现取 ----
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' })
const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: 'tidemark/prod' }))).SecretString)
const agentKeys = JSON.parse(secret.TIDEMARK_AGENT_KEYS)
const keyFor = (agentId) => Object.entries(agentKeys).find(([, p]) => p.agent_id === agentId)?.[0]
const DEMO_KEY = keyFor('demo-agent'), SECOND_KEY = keyFor('second-agent')
assert.ok(DEMO_KEY && SECOND_KEY && secret.TIDEMARK_ADMIN_KEY, 'secret must carry demo/second agent keys and admin key')

const withClient = async (headers, fn) => {
  const c = new Client({ name: 'tidemark-smoke', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args })
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) }
}

const suite = 'smoke-' + randomUUID().slice(0, 8)
const episode = `${suite}-ep`, attemptId = `${suite}-att`, taskId = `${suite}-task`
const content = `tidemark smoke probe ${suite}: the tide leaves an auditable mark`

// S1 health
{
  const h = await (await fetch(url + '/health')).json()
  assert.equal(h.ok, true)
  assert.equal(h.tools.length, 5, 'frozen agent face: exactly 5 tools')
  console.log('PASS S1 /health up, 5-tool face intact')
}

// S2 tools/list == 冻结 §12 五工具
await withClient({}, async (c) => {
  const names = (await c.listTools()).tools.map(t => t.name).sort()
  assert.deepEqual(names, ['log_event', 'pin', 'recall', 'remember', 'report_outcome'])
  console.log('PASS S2 tools/list matches frozen face')
})

// S3 无 key：拒绝
await withClient({}, async (c) => {
  const r = await call(c, 'remember', { content: 'x', episode_id: episode, request_id: randomUUID() })
  assert.equal(r.isError, true); assert.equal(r.body.ok, false)
  console.log('PASS S3 unauthorized rejected')
})

let memoryId, rrId, receiptItemId, evidenceEventId, rememberRid
await withClient({ 'x-tidemark-auth': DEMO_KEY }, async (c) => {
  // S4 remember
  rememberRid = randomUUID()
  const rem = await call(c, 'remember', { content, episode_id: episode, request_id: rememberRid })
  assert.equal(rem.body.ok, true, `remember: ${JSON.stringify(rem.body)}`)
  memoryId = rem.body.memory_id
  console.log('PASS S4 remember accepted')

  // S5 recall 命中 + receipt
  rrId = randomUUID()
  const rec = await call(c, 'recall', { query: content, purpose: 'smoke-verification', episode_id: episode, attempt_id: attemptId, request_id: rrId })
  assert.equal(rec.body.ok, true, `recall: ${JSON.stringify(rec.body)}`)
  const item = rec.body.receipt.items.find(i => i.memory_id === memoryId && i.injected)
  assert.ok(item, 'remembered row must come back injected')
  receiptItemId = item.receipt_item_id
  console.log('PASS S5 recall returns injected receipt item')

  // S6 memory_used 证据（server 对 receipt 校验三元组）
  const ev = await call(c, 'log_event', { episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, request_id: randomUUID(),
    event_type: 'memory_used', payload: { recall_request_id: rrId, receipt_item_id: receiptItemId, memory_id: memoryId } })
  assert.equal(ev.body.ok, true, `memory_used: ${JSON.stringify(ev.body)}`)
  evidenceEventId = ev.body.event_id
  console.log('PASS S6 item-bound memory_used evidence logged')

  // S7 report_outcome success + credited（outcome-gated plasticity 上线闭环）
  const ro = await call(c, 'report_outcome', { outcome_request_id: randomUUID(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId,
    status: 'success', attributions: [{ recall_request_id: rrId, receipt_item_id: receiptItemId, memory_id: memoryId, role: 'credited', evidence_event_id: evidenceEventId }] })
  assert.equal(ro.body.ok, true, `report_outcome: ${JSON.stringify(ro.body)}`)
  console.log('PASS S7 outcome settled, credited attribution applied')

  // S9 幂等重放（同 request_id 的 remember 返回原 memory_id）
  const replay = await call(c, 'remember', { content, episode_id: episode, request_id: rememberRid })
  assert.equal(replay.body.ok, true)
  assert.equal(replay.body.memory_id, memoryId, 'idempotent replay returns the same memory')
  console.log('PASS S9 request idempotency holds over the wire')
})

// S8 pin 双门：无 capability 拒 / 有 capability 过（随后恢复 unpin）
await withClient({ 'x-tidemark-auth': SECOND_KEY }, async (c) => {
  const denied = await call(c, 'pin', { memory_id: memoryId, pinned: true, reason: 'smoke', request_id: randomUUID() })
  assert.equal(denied.body.ok, false)
  assert.equal(denied.body.error, 'pin_capability_required')
})
await withClient({ 'x-tidemark-auth': DEMO_KEY }, async (c) => {
  const pin = await call(c, 'pin', { memory_id: memoryId, pinned: true, reason: 'smoke', request_id: randomUUID() })
  assert.equal(pin.body.ok, true, `pin: ${JSON.stringify(pin.body)}`)
  const unpin = await call(c, 'pin', { memory_id: memoryId, pinned: false, reason: 'smoke', request_id: randomUUID() })
  assert.equal(unpin.body.ok, true)
  console.log('PASS S8 pin capability gate + pin/unpin round trip')
})

// S10 admin forget（P0-08 面上线）：删除 -> recall 不再返回 -> 幂等 already_forgotten
{
  const forget = async () => (await fetch(url + '/admin/forget', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tidemark-admin': secret.TIDEMARK_ADMIN_KEY },
    body: JSON.stringify({ tenant_id: 'demo-tenant', memory_id: memoryId, reason: 'smoke_cleanup' }) })).json()
  const f1 = await forget()
  assert.equal(f1.ok, true, `forget: ${JSON.stringify(f1)}`)
  assert.ok(f1.deleted.includes(memoryId))
  await withClient({ 'x-tidemark-auth': DEMO_KEY }, async (c) => {
    const rec = await call(c, 'recall', { query: content, purpose: 'smoke-verification', episode_id: episode, attempt_id: attemptId + '-2', request_id: randomUUID() })
    assert.equal(rec.body.ok, true)
    assert.ok(!rec.body.receipt.items.some(i => i.memory_id === memoryId), 'forgotten row must not resurface')
  })
  const f2 = await forget()
  assert.equal(f2.ok, true)
  assert.equal(f2.already_forgotten, true, 'second forget is idempotent')
  console.log('PASS S10 admin forget end-to-end + idempotent tombstone')
}

// S11 夜间幂等：先隔空制造反省工作量（同 episode/task 的 failure->success 配对，全走公网
// 工具），再以同一 canonical scheduled_for 连续 invoke 两次——第一次 claim 并 completed，
// 第二次撞 nightly_runs 唯一键不得二次提交。空租户三 job 全 no_work 不 claim run 行，
// 那种"零行零重复"证明不了幂等，所以工作量是本场景的前置。
{
  const rEp = `${suite}-r-ep`, rTask = `${suite}-r-task`
  const attF = `${suite}-r-att-f`, attS = `${suite}-r-att-s`
  await withClient({ 'x-tidemark-auth': DEMO_KEY }, async (c) => {
    const evF = await call(c, 'log_event', { episode_id: rEp, task_instance_id: rTask, attempt_id: attF, request_id: randomUUID(),
      event_type: 'tool_error', tool_name: 'smoke_probe_tool', payload: { error_type: 'timeout', trace_id: randomUUID(), args_digest: 'a'.repeat(64) } })
    assert.equal(evF.body.ok, true, `tool_error: ${JSON.stringify(evF.body)}`)
    const roF = await call(c, 'report_outcome', { outcome_request_id: randomUUID(), episode_id: rEp, task_instance_id: rTask, attempt_id: attF, status: 'failure' })
    assert.equal(roF.body.ok, true, `failure outcome: ${JSON.stringify(roF.body)}`)
    const evS = await call(c, 'log_event', { episode_id: rEp, task_instance_id: rTask, attempt_id: attS, request_id: randomUUID(),
      event_type: 'note', payload: { ref: randomUUID() } })
    assert.equal(evS.body.ok, true, `note: ${JSON.stringify(evS.body)}`)
    const roS = await call(c, 'report_outcome', { outcome_request_id: randomUUID(), episode_id: rEp, task_instance_id: rTask, attempt_id: attS, status: 'success' })
    assert.equal(roS.body.ok, true, `success outcome: ${JSON.stringify(roS.body)}`)
  })
  // 取【下一个】分钟界做 canonical scheduled_for：反省扫描要求双方 reported_at <= evaluation_at，
  // 向下取整会把刚造出的 outcomes 排除在窗外（真实 EventBridge 触发时 outcomes 天然先于计划时刻，
  // 只有 smoke 的合成时序需要这一步）。至多超前 60s，远在 +5min 未来闸内。
  const t = new Date(); t.setUTCSeconds(0, 0); t.setUTCMinutes(t.getUTCMinutes() + 1)
  const scheduledFor = t.toISOString()
  const invoke = (tag) => {
    const out = join(tmpdir(), `tidemark-smoke-${tag}.json`)
    const meta = JSON.parse(execFileSync(AWS_CLI, ['lambda', 'invoke', '--function-name', 'tidemark-nightly',
      '--cli-binary-format', 'raw-in-base64-out', '--payload', JSON.stringify({ scheduled_for: scheduledFor }), out], { encoding: 'utf8' }))
    const payload = JSON.parse(readFileSync(out, 'utf8'))
    rmSync(out, { force: true })
    assert.equal(meta.StatusCode, 200, `invoke ${tag} status`)
    assert.ok(!meta.FunctionError, `invoke ${tag} must not error: ${JSON.stringify(payload).slice(0, 200)}`)
    return payload
  }
  const first = invoke('first')
  assert.equal(first.scheduled_for, scheduledFor, 'handler canonicalizes to the same minute')
  // handler 成功返回本身就意味着零非终态（非终态会 throw -> FunctionError），这里再显式断言
  assert.ok(['completed', 'completed_degraded'].includes(first.results[0].top), JSON.stringify(first))
  assert.equal(first.results[0].pending.length, 0, JSON.stringify(first))
  const second = invoke('second')
  assert.ok(['completed', 'completed_degraded'].includes(second.results[0].top), JSON.stringify(second))

  // serverless 集群冷唤醒会连环 ECONNRESET——用迁移器同款带重试的连接
  const db = await connectWithRetry(withDatabase(process.env.COCKROACH_DATABASE_URL, PROD_DB), { label: 'smoke-db' })
  try {
    const rows = (await db.query(
      `SELECT job_kind, count(*)::INT AS n, count(*) FILTER (WHERE status = 'completed')::INT AS done
       FROM nightly_runs WHERE tenant_id = 'demo-tenant' AND scheduled_for = $1 GROUP BY job_kind ORDER BY job_kind`,
      [scheduledFor])).rows
    const refl = rows.find(r => r.job_kind === 'reflection')
    assert.ok(refl, `reflection run must have claimed (pair was due): ${JSON.stringify(rows)}`)
    assert.equal(Number(refl.done), 1, `reflection run completed: ${JSON.stringify(rows)}`)
    for (const r of rows) assert.equal(Number(r.n), 1, `duplicate trigger must not double-commit ${r.job_kind}: ${JSON.stringify(rows)}`)
    const pair = (await db.query(
      `SELECT experience_id FROM reflection_pairs WHERE tenant_id = 'demo-tenant' AND failure_attempt_id = $1 AND success_attempt_id = $2`,
      [attF, attS])).rows
    assert.equal(pair.length, 1, `exactly-once pair ledger row: ${JSON.stringify(pair)}`)
    // 措辞诚实（round-2 P1-5）：这是同步双 invoke 证明 handler 对同一 canonical schedule 的
    // run-key 幂等；真实 EventBridge 异步重投/DLQ 由 S13 的控制面断言覆盖，不在此冒充。
    console.log(`PASS S11 double invoke of one canonical schedule commits once (${rows.map(r => `${r.job_kind}:${r.n}`).join(' ')}, pair ledger exactly-once)`)

    // 清理：把 smoke 生出的 experience 用 admin forget 收走（顺带线上验 derived 硬删路径）
    const expId = pair[0].experience_id
    const f = await (await fetch(url + '/admin/forget', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tidemark-admin': secret.TIDEMARK_ADMIN_KEY },
      body: JSON.stringify({ tenant_id: 'demo-tenant', memory_id: expId, reason: 'smoke_cleanup' }) })).json()
    assert.equal(f.ok, true, `experience cleanup: ${JSON.stringify(f)}`)
    console.log('PASS S12 smoke experience forgotten via admin surface')
  } finally { await db.end() }
}

// S13 异步失败通路控制面验收（round-2 P0-3/P1-5，round-3 P1-4 加固）：
// 配置 + 权限一起验，全部 exact equality——后缀比对证明不了同 account/region/queue，
// 配置在而权限断线时投递照样失败，验收不许假绿。只读断言，不等真实异步重试。
{
  const cli = (args) => JSON.parse(execFileSync(AWS_CLI, [...args, '--output', 'json'], { encoding: 'utf8' }))
  // 事实源：DLQ 的真实 QueueArn + 当前 rule ARN + nightly 函数的执行 role
  const dlqUrl = cli(['sqs', 'get-queue-url', '--queue-name', 'tidemark-nightly-dlq']).QueueUrl
  const qAttrs = cli(['sqs', 'get-queue-attributes', '--queue-url', dlqUrl, '--attribute-names', 'QueueArn', 'Policy']).Attributes
  const dlqArn = qAttrs.QueueArn
  const ruleArn = cli(['events', 'describe-rule', '--name', 'tidemark-nightly']).Arn

  // 层2：Lambda async event-invoke-config，OnFailure 与 DLQ 精确等值
  const eic = cli(['lambda', 'get-function-event-invoke-config', '--function-name', 'tidemark-nightly'])
  assert.equal(eic.MaximumRetryAttempts, 2, 'async retries explicitly 2')
  assert.equal(eic.MaximumEventAgeInSeconds, 21600, 'async max age explicitly 6h')
  assert.equal(eic.DestinationConfig?.OnFailure?.Destination, dlqArn, 'OnFailure destination === QueueArn (exact)')

  // 层1：EventBridge target 配置，DLQ 精确等值
  const targets = cli(['events', 'list-targets-by-rule', '--rule', 'tidemark-nightly']).Targets
  assert.equal(targets.length, 1)
  assert.equal(targets[0].DeadLetterConfig?.Arn, dlqArn, 'delivery DLQ === QueueArn (exact)')
  assert.equal(targets[0].RetryPolicy?.MaximumRetryAttempts, 2, 'delivery retry policy explicit')
  assert.equal(targets[0].RetryPolicy?.MaximumEventAgeInSeconds, 3600, 'delivery max age explicit')

  // 层1 权限：queue policy 必须放行 events.amazonaws.com 对本 queue 的 SendMessage，且收窄到当前 rule
  const asList = (x) => Array.isArray(x) ? x : [x]
  const qPol = JSON.parse(qAttrs.Policy ?? '{"Statement":[]}')
  const eventsGrant = asList(qPol.Statement).some(s => s.Effect === 'Allow'
    && s.Principal?.Service === 'events.amazonaws.com'
    && asList(s.Action).includes('sqs:SendMessage')
    && asList(s.Resource).includes(dlqArn)
    && s.Condition?.ArnEquals?.['aws:SourceArn'] === ruleArn)
  assert.ok(eventsGrant, `queue policy must grant events.amazonaws.com SendMessage scoped to the rule: ${qAttrs.Policy}`)

  // 层2 权限：nightly 执行 role 对该 exact ARN 有 sqs:SendMessage（OnFailure 投递走函数 role）
  const roleArn = cli(['lambda', 'get-function', '--function-name', 'tidemark-nightly']).Configuration.Role
  const roleName = roleArn.split('/').pop()
  const rolePol = cli(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', 'tidemark-secrets-bedrock']).PolicyDocument
  const roleGrant = asList(rolePol.Statement).some(s => s.Effect === 'Allow'
    && asList(s.Action).includes('sqs:SendMessage')
    && asList(s.Resource).includes(dlqArn))
  assert.ok(roleGrant, `execution role ${roleName} must hold sqs:SendMessage on ${dlqArn}`)
  console.log('PASS S13 two-layer async failure wiring: config AND permissions verified by exact ARN')
}

console.log(`ALL P0-09 SMOKE ASSERTIONS PASSED (${suite})`)
