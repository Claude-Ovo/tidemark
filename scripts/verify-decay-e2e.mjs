// 自然衰减 E2E 留证（8/8 约定，8/10 执行；可复用于 8/16 录制日 tidemark-final 基线核验）。
// 命题：真实 wall-clock 流逝 N 天后，服务面（vizOcean 单事务快照）的 effective_strength
// 与「存储锚点 + 唯一衰减公式」独立重算逐条一致——期间零改写、零后台任务（结论 1/2 的
// 时间维度实证）；塑性痕迹（credited 抬升的 anchor）在衰减中转化为真实的存活优势。
// 运行：node scripts/verify-decay-e2e.mjs [--tenant=demo-tenant] [--agent=rehearsal-0808c]
// 输出：逐条对表 + PASS/FAIL 汇总（served vs recomputed |Δ|<1e-9）+ 分层占用。
import { fileURLToPath } from 'node:url'
if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'
process.env.TIDEMARK_DEV_INSECURE = process.env.TIDEMARK_DEV_INSECURE || '1'

const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? dflt
const TENANT = arg('tenant', 'demo-tenant')
const AGENT = arg('agent', 'rehearsal-0808c')

const { getPool } = await import('../src/lib/db.mjs')
const { decayEffective } = await import('../src/lib/decay.mjs')
const { vizOcean } = await import('../src/viz/ocean.mjs')

const pool = getPool()
const q = async (sql, params = [], tries = 6) => {
  for (let i = 1; ; i++) {
    try { return await pool.query(sql, params) }
    catch (e) {
      if (i >= tries) throw e
      console.error(JSON.stringify({ evt: 'e2e_retry', attempt: i, code: e.code ?? String(e.message).slice(0, 40) }))
      await new Promise(r => setTimeout(r, 1200 * i))
    }
  }
}

// ① 存储锚点（真相源行内字段）+ DB 时钟（对表用同一只钟，不用本机钟）
const { rows: memRows } = await q(`
  SELECT memory_id, kind, pinned, importance, state,
         strength_anchor, strength_anchor_at, half_life_hours,
         credited_success_count, evidenced_blame_count, created_at, now() AS db_now
  FROM memories
  WHERE tenant_id = $1 AND agent_id = $2 AND admission = 'accepted'
  ORDER BY strength_anchor DESC, memory_id`, [TENANT, AGENT])
if (!memRows.length) { console.error(`no memories for ${TENANT}/${AGENT}`); process.exit(1) }
const dbNow = new Date(memRows[0].db_now).getTime()

// ② 服务面：vizOcean 单事务快照（生产 viz 面同一路径）
const principal = { tenant_id: TENANT, agent_id: AGENT, capabilities: [], scope: 'viz' }
const snap = await vizOcean({ principal })
if (!snap.ok) { console.error(`vizOcean failed: ${snap.error}`); process.exit(1) }
const served = new Map([...snap.episodes.flatMap(e => e.memories), ...snap.loose]
  .map(m => [m.memory_id, m]))
const snapNow = new Date(snap.snapshot_at).getTime()

// ③ 逐条对表：served vs 独立重算（各自的时钟——快照值用 snapshot_at 重算）
let pass = 0, fail = 0
const ageDays = (t) => ((dbNow - new Date(t).getTime()) / 864e5).toFixed(2)
console.log(`tenant=${TENANT} agent=${AGENT} rows=${memRows.length}`)
console.log(`db_now=${new Date(dbNow).toISOString()} snapshot_at=${snap.snapshot_at}`)
console.log(`age of corpus: ${ageDays(memRows[memRows.length - 1].created_at)}–${ageDays(memRows[0].created_at)} days (real wall-clock)`)
console.log('')
console.log('pinned imp   anchor  anchored_at(age d)  eff@snapshot  served     |Δ|        kind      c/b')
for (const r of memRows) {
  const s = served.get(r.memory_id)
  const effAtSnap = decayEffective(r, snapNow)
  const delta = s ? Math.abs(effAtSnap - Number(s.effective_strength)) : null
  const ok = s && delta < 1e-9
  ok ? pass++ : fail++
  console.log([
    String(!!r.pinned).padEnd(6),
    Number(r.importance).toFixed(2),
    Number(r.strength_anchor).toFixed(4).padStart(7),
    `${String(r.strength_anchor_at).slice(5, 16)}(${ageDays(r.strength_anchor_at).padStart(5)})`,
    effAtSnap.toFixed(6).padStart(9),
    s ? Number(s.effective_strength).toFixed(6).padStart(9) : '  ABSENT ',
    delta == null ? '—' : delta.toExponential(1),
    String(r.kind ?? '—').padEnd(9),
    `${r.credited_success_count}/${r.evidenced_blame_count}`,
  ].join('  '))
}
console.log('')
const states = {}
let belowFade = 0
for (const r of memRows) {
  states[r.state] = (states[r.state] ?? 0) + 1
  if (!r.pinned && decayEffective(r, snapNow) < Number(snap.fade_threshold)) belowFade++
}
console.log(`states: ${JSON.stringify(states)} fade_threshold=${snap.fade_threshold} below_fade_now=${belowFade}`)
console.log(fail === 0
  ? `PASS ${pass}/${memRows.length}: served === recomputed（|Δ|<1e-9）——真实流逝期间零改写，衰减只在读取时发生`
  : `FAIL: ${fail} rows diverged`)
process.exit(fail === 0 ? 0 : 1)
