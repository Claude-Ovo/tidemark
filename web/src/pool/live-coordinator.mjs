// live activity 消费协调器（纯逻辑、依赖注入，node 可测——live 环一审 P1-2/3/4/5）。
// 职责与不变量：
//   bootstrap：durable cursor 缺失时用 head cursor 对齐（历史事件绝不重演）
//   持久边界：cursor / 去重集 / 快照单调水位 全部写入注入的 storage
//   （页面用 sessionStorage——刷新 / StrictMode remount 不漏不重）
//   poll 单飞：整条 drain 链串行，慢链不与新链并发，durable cursor 永不回退
//   超页续排：maxPages 用尽保留 page_cursor，下轮从续排点继续，不从旧 durable 重排队
//   快照单飞 + 单调门：in-flight 合并（queued 重跑），`snapshot_at <= 已应用` 的旧响应拒收
//   pendingSpawn：落滴未 attach 的新增 id 记账，相邻快照不得重复生成同一粒子
export const makeLiveCoordinator = ({ fetchActivity, fetchSnapshot, storage, onEvent, onSnapshot, maxPages = 10, seenCap = 2000 }) => {
  let durable = storage.get('tm_cursor') || null
  let pendingPage = storage.get('tm_page') || null
  let lastSnapAt = storage.get('tm_snap_at') || ''
  const seen = new Set(JSON.parse(storage.get('tm_seen') || '[]'))
  const pendingSpawn = new Set()
  let polling = false
  let ready = !!durable        // restored 即就绪；否则必须等 bootstrap——poll 抢跑会变 epoch 拉取
  let snapInFlight = false, snapQueued = false

  const persistSeen = () => {
    const arr = [...seen]
    storage.set('tm_seen', JSON.stringify(arr.slice(Math.max(0, arr.length - seenCap))))
  }
  const dedupe = (e) => {
    const k = `${e.kind}|${e.event_id}`
    if (seen.has(k)) return false
    if (seen.size > seenCap) { let i = 0; for (const x of seen) { seen.delete(x); if (++i > seenCap / 2) break } }
    seen.add(k)
    return true
  }

  return {
    async bootstrap() {
      if (durable) { ready = true; return 'restored' }                 // remount：沿用持久 cursor + 持久去重集
      const r = await fetchActivity({ head: true })
      if (!r?.ok) return 'error'
      durable = r.cursor
      storage.set('tm_cursor', durable)
      ready = true
      return 'head'
    },
    async poll() {
      if (!ready) return 'not-ready'                 // bootstrap 未完成：拒绝——绝不 epoch 拉取（实测抓获的抢跑）
      if (polling) return 'busy'                     // 单飞：慢链在途时新 tick 直接让路
      polling = true
      try {
        let after = pendingPage ?? durable
        for (let page = 0; page < maxPages; page++) {
          const r = await fetchActivity({ after })
          if (!r?.ok) return 'error'
          durable = r.cursor                          // 串行链内推进——不可能被旧链覆盖
          storage.set('tm_cursor', durable)
          for (const e of r.events) if (dedupe(e)) onEvent(e)
          persistSeen()
          if (!r.has_more) { pendingPage = null; storage.set('tm_page', ''); return 'done' }
          after = r.page_cursor
          pendingPage = after                         // 超页续排点（P1-3）
          storage.set('tm_page', after)
        }
        return 'paged-out'
      } finally { polling = false }
    },
    async refreshSnapshot() {
      if (snapInFlight) { snapQueued = true; return 'queued' }   // 在途合并：完成后重跑一次
      snapInFlight = true
      try {
        let verdict = 'applied'
        do {
          snapQueued = false
          const s = await fetchSnapshot()
          if (!s?.ok) { verdict = 'error'; continue }
          const at = String(s.snapshot_at)
          if (at <= lastSnapAt) { verdict = 'stale-rejected'; continue }   // 单调门（P1-4）
          lastSnapAt = at
          storage.set('tm_snap_at', at)
          onSnapshot(s)
          verdict = 'applied'
        } while (snapQueued)
        return verdict
      } finally { snapInFlight = false }
    },
    markPending(id) { pendingSpawn.add(id) },
    clearPending(id) { pendingSpawn.delete(id) },
    isPending(id) { return pendingSpawn.has(id) },
    _debug() { return { durable, pendingPage, lastSnapAt, seenSize: seen.size, polling } },
  }
}

// outcome 事件 → 动作列表（纯函数，零动作规则集中在此测：仅 applied===true 的
// credited/blamed 产生动作；cancelled 无 item、late/未 applied 一律空）
export const outcomeActions = (e) =>
  (e.items ?? []).filter(it => it.applied === true && (it.role === 'credited' || it.role === 'blamed'))
    .map(it => ({ memory_id: it.memory_id, role: it.role }))
