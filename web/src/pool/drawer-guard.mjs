// drawer 请求生命周期守卫（纯逻辑，node 可测——交互层一审 P1-4）：
// 快速 A→B 时迟到的 A 不得覆盖 B；close 后迟到的响应不得重写抽屉。
// 每次 open 铸新 seq 并 abort 前一请求；响应只有在 seq 仍是当前且抽屉仍 open 时才可用。
export const makeDrawerGuard = () => {
  let seq = 0
  let open = false
  let controller = null
  return {
    begin() {                         // open 或重开：返回本次请求的 token
      controller?.abort()
      controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      open = true
      return { seq: ++seq, signal: controller?.signal }
    },
    close() {                          // 关闭：abort 在途请求，之后一切迟到响应失效
      open = false
      controller?.abort()
      controller = null
      seq++
    },
    isCurrent(token) { return open && token.seq === seq },
    isOpen() { return open },
  }
}
