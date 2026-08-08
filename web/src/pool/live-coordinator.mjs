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

export const makeLiveCoordinator = ({ fetchActivity, fetchSnapshot, storage, onEvent, onSnapshot, maxPages = 10, seenHardCap = 20000 }) => {
  let ns = null                 // `tm.${b64u(tenant)}.${b64u(agent)}.` —— bootstrap 后才有
  let durable = null
  let pendingPage = null
  let lastSnapAt = ''
  let seen = new Map()          // key -> atMs（四审 P1-1：淘汰按 watermark 时间，不按计数）
  const pendingSpawn = new Set()
  let ready = false
  let halted = false            // 显式停流（seen 超硬界仍无法安全淘汰时——绝不静默重演）
  let hadError = false          // 首次 bootstrap 失败标记：恢复时向页面报 degraded
  let polling = false
  let bootstrapping = false
  let snapInFlight = false, snapQueued = false

  const K = (k) => ns + k
  const atMs = (x) => { const v = Date.parse(x); return Number.isNaN(v) ? 0 : v }
  const persistSeen = () => storage.set(K('seen'), JSON.stringify([...seen]))
  // watermark 淘汰：重放只覆盖 > watermark 的事件——时间早于 watermark 的 key 永不可能
  // 再被重放，淘汰绝对安全。计数淘汰会让旧热事件复活重演（Codex 四审等比判别抓获）。
  const evictByWatermark = (wmAt) => {
    const wmMs = atMs(wmAt)
    if (!wmMs) return
    for (const [k, v] of seen) if (v < wmMs) seen.delete(k)
    if (seen.size > seenHardCap) halted = true          // 无法安全保住完整 hot set：显式停流
  }
  const dedupe = (e) => {
    const k = `${e.kind}|${e.event_id}`
    if (seen.has(k)) return false
    seen.set(k, atMs(e.occurred_at))
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
        if (!snap?.ok || !snap.activity_baseline) { hadError = true; return 'error' }
        const b = snap.activity_baseline
        if (b.error) { hadError = true; return 'error' }          // 热窗口越界：诚实失败，poll 自愈重试
        ns = `tm.${b64u(snap.tenant_id)}.${b64u(snap.agent_id)}.`
        for (const k of LEGACY_KEYS) storage.set(k, '')           // 无 scope 旧键 fail-closed 清除
        // 三审 P1-1：新 boot snapshot 的 baseline 永远是最新可见性边界——旧 cursor 不得压过它。
        // 持久 seen 与 baseline seen 并集（都是"已表示"证据），随后按 baseline watermark 淘汰。
        const persisted = new Map(JSON.parse(storage.get(K('seen')) || '[]'))
        durable = b.cursor
        pendingPage = null
        storage.set(K('page'), '')
        seen = new Map(persisted)
        for (const it of (b.seen ?? [])) seen.set(it.k, atMs(it.at))
        evictByWatermark(b.watermark_at)
        lastSnapAt = String(snap.snapshot_at)
        storage.set(K('cursor'), durable)
        storage.set(K('snap_at'), lastSnapAt)
        persistSeen()
        // 四审 P1-2：自愈路径拿到的 snapshot 必须【原子交给画面】再 ready——
        // 消费边界与画面绝不分离（初始路径由页面自己 applySnapshot，不双重应用）
        if (!snapMaybe) onSnapshot(snap)
        ready = true
        if (hadError) { hadError = false; return 'recovered-degraded' }   // 四审 P1-3：显式降级口径
        return persisted.size ? 'baseline-merged' : 'baseline'
      } finally { bootstrapping = false }
    },
    async poll() {
      if (halted) return 'halted-overloaded'                      // 显式停流，绝不静默重演
      if (!ready) {                                               // 自愈：瞬断后的 tick 重新 bootstrap
        const v = await this.bootstrap()
        if (!ready) return `not-ready(${v})`
        if (v === 'recovered-degraded') return v                  // 把降级信号透给页面
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
          evictByWatermark(r.watermark_at)                        // 安全淘汰：只丢重放窗口外的 key
          persistSeen()
          if (halted) return 'halted-overloaded'
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
    _debug() { return { ns, durable, pendingPage, lastSnapAt, seenSize: seen.size, polling, ready, halted, pendingCount: pendingSpawn.size } },
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
