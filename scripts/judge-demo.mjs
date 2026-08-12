// Judge Demo (CLI) — a deterministic proof that runs through the REAL
// production path: real MCP tools, real CockroachDB writes, real vector recall,
// real receipts, real terminal outcomes, real persistence.
//
// It answers the one question a judge actually has: "is the memory really
// changing, and only where you claim it does?"
//
// The ten steps live in src/viz/judge-run.mjs and are shared with the HTTP
// trigger (POST /viz/judge-run), so what a judge clicks and what we run here
// can never drift apart.
//
// Usage:
//   node --env-file=.env scripts/judge-demo.mjs [--agent=judge-demo]
//     [--run-key=judge-v1] [--json]
import { fileURLToPath } from 'node:url'

if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'local-onnx'
process.env.TIDEMARK_DEV_INSECURE = process.env.TIDEMARK_DEV_INSECURE || '1'
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'

const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? dflt
const JSON_ONLY = process.argv.includes('--json')

const { runJudgeDemo, JUDGE_CFG, bucketRunKey } = await import('../src/viz/judge-run.mjs')
const { getPool } = await import('../src/lib/db.mjs')

const say = (line) => { if (!JSON_ONLY) console.log(line) }
const short = (id) => String(id ?? '').slice(0, 8)
const fmtDiff = (d) => d.map(x => `${x.field} ${x.before} -> ${x.after}`).join('; ') || 'unchanged'

let proof
try {
  proof = await runJudgeDemo({
    tenantId: arg('tenant', JUDGE_CFG.tenant_id),
    agentId: arg('agent', JUDGE_CFG.agent_id),
    runKey: arg('run-key', bucketRunKey(Date.now())),
    onStep: (s) => {
      say(`\n[${s.step}/10] ${s.title}`)
      if (s.memories) for (const [label, id] of Object.entries(s.memories)) say(`      ${label.padEnd(7)} ${id}`)
      if (s.recall_request_id && s.candidates != null) say(`      candidates=${s.candidates} injected=${s.injected}`)
      if (s.receipt_scores) {
        for (const r of s.receipt_scores) {
          say(`      ${short(r.memory_id)} rank=${r.rank} injected=${r.injected} sim=${Number(r.similarity).toFixed(4)} ` +
            `eff=${Number(r.effective_strength).toFixed(4)} util=${Number(r.utility).toFixed(3)} final=${Number(r.final_score).toFixed(4)}`)
        }
      }
      if (s.step === 4) say(`      ${s.verdict === 'FAILED' ? 'FAIL' : 'PASS'}: ${s.verdict}`)
      if (s.events) for (const e of s.events) say(`      ${e.event_type.padEnd(14)} ${e.event_id}${e.tool_name ? `  tool=${e.tool_name}` : ''}`)
      if (s.step === 6) {
        say(`      outcome_request_id=${s.outcome_request_id} plasticity_applied=${s.plasticity_applied}`)
        for (const it of s.items) say(`      item ${short(it.memory_id)} role=${it.role} applied=${it.applied}`)
      }
      if (s.step === 7) {
        say(`      credited : ${fmtDiff(s.credited_changed_fields)}`)
        say(`      control  : ${s.control_changed_fields.length ? 'CHANGED (bug)' : 'unchanged (correct)'}`)
      }
      if (s.step === 8) for (const [id, d] of Object.entries(s.per_memory)) say(`      ${short(id)}: ${fmtDiff(d)}`)
      if (s.step === 9) say(`      ${s.matches_post_outcome_state ? 'PASS' : 'FAIL'}: state survives a fresh transaction`)
    },
  })
} catch (e) {
  console.error(`FAIL ${e.message}${e.detail ? `: ${JSON.stringify(e.detail).slice(0, 300)}` : ''}`)
  await getPool().end()
  process.exit(1)
}

if (JSON_ONLY) console.log(JSON.stringify(proof, null, 2))
else {
  const s = proof.summary
  say('')
  say(`  run_key ${proof.run_key} (same key inside the window replays instead of duplicating)`)
  say(`  recall changed nothing            : ${s.recall_changed_nothing ? 'PASS' : 'FAIL'}`)
  say(`  outcome credited only used memory : ${s.outcome_credited_only_used_memory ? 'PASS' : 'FAIL'}`)
  say(`  persisted after fresh read        : ${s.persisted_after_fresh_read ? 'PASS' : 'FAIL'}`)
  say('')
  say('  Seeded demo data, real path: same tools, same database, same retrieval,')
  say('  same receipts and same outcome API as production traffic.')
}

await getPool().end()
process.exit(0)
