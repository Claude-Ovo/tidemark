// live activity 消费协调器（纯逻辑、依赖注入，node 可测——live 环一审 P1-2/3/4/5 + 二审全项）。
// 职责与不变量：
//   bootstrap 基线来自 /viz/ocean 的 activity_baseline（与快照同一可见性边界——
//   closed cursor + 快照已见热窗口 keys；truncated 时 fail-closed 用 snapshot 哨兵，
//   零假重演，代价是丢过载边缘的晚提交动画并如实上报）
//   存储命名空间：`tm.${tenant}.${agent}.*`——切换 principal 绝不复用他人 checkpoint；
//   旧的无 scope 键 fail-closed 清除
//   bootstrap 单飞 + 失败自愈：poll 在未就绪时触发重新 bootstrap，一次瞬断不永久沉默
//   poll 单飞：drain 链串行，durable cursor 永不回退；超页保留 page_cursor 续排
//   快照单飞 + 单调门：in-flight 合并，`snapshot_at <= 已应用` 拒收
//   pendingSpawn：落滴在途 id 记账；attach/abort 统一清账（不清=幽灵粒子，二审 P1-3）
const LEGACY_KEYS = ['tm_cursor', 'tm_page', 'tm_snap_at', 'tm_seen']
// 命名空间分量无碰撞编码（三审 P1-4：'a.b'+'c' 与 'a'+'b.c' 不得同键）——base64url 无 '.'
const b64u = (x) => typeof Buffer !== 'undefined'
  ? Buffer.from(String(x), 'utf8').toString('base64url')
  : btoa(unescape(encodeURIComponent(String(x)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const makeLiveCoordinator = ({ fetchActivity, fetchSnapshot, storage, onEvent, onSnapshot, maxPages = 10, seenCap = 2000 }) => {
  let ns = null                 // `tm.${tenant}.${agent}.` —— bootstrap 后才有
  let durable = null
  let pendingPage = null
  let lastSnapAt = ''
  let seen = new Set()
  const pendingSpawn = new Set()
  let ready = false
  let polling = false
  let bootstrapping = false
  let snapInFlight = false, snapQueued = false

  const K = (k) => ns + k
  const persistSeen = () => {
    const arr = [...seen]
    storage.set(K('seen'), JSON.stringify(arr.slice(Math.max(0, arr.length - seenCap))))
  }
  const dedupe = (e) => {
    const k = `${e.kind}|${e.event_id}`
    if (seen.has(k)) return false
    if (seen.size > seenCap) { let i = 0; for (const x of seen) { seen.delete(x); if (++i > seenCap / 2) break } }
    seen.add(k)
    return true
  }

  return {
    // baseline 驱动的 bootstrap：snap 是 /viz/ocean 的完整响应（单飞；可重入自愈）
    async bootstrap(snapMaybe) {
      if (ready) return 'ready'
      if (bootstrapping) return 'busy'
      bootstrapping = true
      try {
        const snap = snapMaybe ?? await fetchSnapshot()
        if (!snap?.ok || !snap.activity_baseline) return 'error'
        const b = snap.activity_baseline
        if (b.error) return 'error'                               // 热窗口越界：诚实失败，poll 自愈重试
        ns = `tm.${b64u(snap.tenant_id)}.${b64u(snap.agent_id)}.`
        for (const k of LEGACY_KEYS) storage.set(k, '')           // 无 scope 旧键 fail-closed 清除
        // 三审 P1-1：新 boot snapshot 的 baseline 永远是最新可见性边界——旧 cursor 不得压过它
        //（离线间隙事件已被新快照表示，restore 旧 cursor 会把它们当新事件重演）。
        // 持久 seen 与 baseline seen_keys 做并集（合并语义：两边都是"已表示"证据），旧 page 作废。
        const persisted = new Set(JSON.parse(storage.get(K('seen')) || '[]'))
        durable = b.cursor
        pendingPage = null
        storage.set(K('page'), '')
        seen = new Set([...persisted, ...(b.seen_keys ?? [])])
        lastSnapAt = String(snap.snapshot_at)
        storage.set(K('cursor'), durable)
        storage.set(K('snap_at'), lastSnapAt)
        persistSeen()
        ready = true
        return persisted.size ? 'baseline-merged' : 'baseline'
      } finally { bootstrapping = false }
    },
    async poll() {
      if (!ready) {                                               // 自愈：瞬断后的 tick 重新 bootstrap
        const v = await this.bootstrap()
        if (!ready) return `not-ready(${v})`
      }
      if (polling) return 'busy'
      polling = true
      try {
        let after = pendingPage ?? durable
        for (let page = 0; page < maxPages; page++) {
          const r = await fetchActivity({ after })
          if (!r?.ok) return 'error'
          durable = r.cursor                                      // 串行链内推进——不可能被旧链覆盖
          storage.set(K('cursor'), durable)
          for (const e of r.events) if (dedupe(e)) onEvent(e)
          persistSeen()
          if (!r.has_more) { pendingPage = null; storage.set(K('page'), ''); return 'done' }
          after = r.page_cursor
          pendingPage = after
          storage.set(K('page'), after)
        }
        return 'paged-out'
      } finally { polling = false }
    },
    async refreshSnapshot() {
      if (!ready) return 'not-ready'
      if (snapInFlight) { snapQueued = true; return 'queued' }
      snapInFlight = true
      try {
        let verdict = 'applied'
        do {
          snapQueued = false
          const s = await fetchSnapshot()
          if (!s?.ok) { verdict = 'error'; continue }
          const at = String(s.snapshot_at)
          if (at <= lastSnapAt) { verdict = 'stale-rejected'; continue }
          lastSnapAt = at
          storage.set(K('snap_at'), at)
          onSnapshot(s)
          verdict = 'applied'
        } while (snapQueued)
        return verdict
      } finally { snapInFlight = false }
    },
    markPending(id) { pendingSpawn.add(id) },
    clearPending(id) { pendingSpawn.delete(id) },
    isPending(id) { return pendingSpawn.has(id) },
    _debug() { return { ns, durable, pendingPage, lastSnapAt, seenSize: seen.size, polling, ready, pendingCount: pendingSpawn.size } },
  }
}

// outcome 事件 → 动作列表（纯函数，零动作规则集中在此测：仅 applied===true 的
// credited/blamed 产生动作；cancelled 无 item、late/未 applied 一律空）
export const outcomeActions = (e) =>
  (e.items ?? []).filter(it => it.applied === true && (it.role === 'credited' || it.role === 'blamed'))
    .map(it => ({ memory_id: it.memory_id, role: it.role }))

// 事件是否值得触发快照刷新（二审 P1-5：cancelled/late/未 applied 零副作用——连 fetch 都不许）
export const eventCausesRefresh = (e) =>
  e.kind === 'remember' || (e.kind === 'outcome' && outcomeActions(e).length > 0)

// 快照 diff（页面 applySnapshot 的纯逻辑半——二审 P1-3 的集成判别在此测）：
// pending 中的 id 不重复生成、也不误删；其余按存在集增删
export const diffSnapshot = (placedIds, currentIds, isPending) => {
  const placedSet = new Set(placedIds)
  const currentSet = new Set(currentIds)
  return {
    added: placedIds.filter(id => !currentSet.has(id) && !isPending(id)),
    removedIds: currentIds.filter(id => !placedSet.has(id) && !isPending(id)),
  }
}
