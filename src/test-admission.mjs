// admission gate 单元测试（table-driven，无 DB 依赖）：node src/test-admission.mjs
import assert from 'node:assert/strict'
import { runAdmissionGate } from './lib/admission.mjs'

const cases = [
  // [名称, 输入, 期望 admission, 期望 reason 片段（可选）]
  ['normal text', { content: 'the tide leaves a mark' }, 'accepted'],
  ['whitespace padding bypass (Codex repro)', { content: ' '.repeat(9000) + 'x' }, 'rejected', 'content_too_large_raw'],
  ['raw oversize', { content: 'x'.repeat(9000) }, 'rejected', 'content_too_large_raw'],
  ['empty after trim', { content: '   ' }, 'rejected', 'content_empty'],
  ['aws key', { content: 'my key AKIAABCDEFGHIJKLMNOP ok' }, 'quarantined', 'aws_access_key_id'],
  ['aws key negative', { content: 'AKIA is a prefix only' }, 'accepted'],
  ['conn string with creds', { content: 'postgresql://u:pass@host:26257/db' }, 'quarantined', 'connection_string_with_credentials'],
  ['conn string no creds negative', { content: 'postgresql://host:26257/db is our endpoint' }, 'accepted'],
  ['private key block', { content: '-----BEGIN RSA PRIVATE KEY----- abc' }, 'quarantined', 'private_key_block'],
  ['private key negative', { content: 'we talked about private keys today' }, 'accepted'],
  ['sk plain', { content: `token=sk-${'A'.repeat(30)}` }, 'quarantined', 'api_secret_key'],
  ['sk segmented (Codex repro)', { content: `token=sk-proj-${'A'.repeat(30)}` }, 'quarantined', 'api_secret_key'],
  ['sk short negative', { content: 'sk-42 is a model name maybe' }, 'accepted'],
  ['password assignment', { content: 'password = hunter22222' }, 'quarantined', 'inline_password_assignment'],
  ['password mention negative', { content: 'she forgot her password again' }, 'accepted'],
  ['kind too long', { content: 'ok', kind: 'k'.repeat(65) }, 'rejected', 'kind_invalid'],
  ['importance out of range', { content: 'ok', importance: 1.5 }, 'rejected', 'importance_out_of_range'],
]

for (const [name, input, want, reasonPart] of cases) {
  const got = runAdmissionGate(input)
  assert.equal(got.admission, want, `${name}: admission ${got.admission} != ${want} (${got.reasons})`)
  if (reasonPart) assert.ok(got.reasons.some(r => r.includes(reasonPart)), `${name}: missing reason ${reasonPart}`)
  if (got.admission !== 'rejected') assert.equal(got.canonical, input.content.trim(), `${name}: canonical must be trimmed content`)
}
console.log(`ALL ADMISSION UNIT TESTS PASSED (${cases.length} cases)`)
