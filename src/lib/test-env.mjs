// 测试前置 env（必须是测试文件的第一个 import——ESM 按 import 顺序执行模块体）。
// 二审#3 教训：??= 会被 node --env-file 预填的变量穿透——测试进程必须【无条件】锁 stub，
// .env 里配了 bedrock 也不许测试碰它。provider 模块加载后再断言一次导出值（双保险）。
process.env.EMBED_PROVIDER = 'stub'
process.env.DREAM_PROVIDER = 'stub'
process.env.TIDEMARK_DEV_INSECURE ??= '1'   // 仅此项保留 ??=：显式配置真 key 属合法测试环境

export const assertStubLocked = async () => {
  const { embedProviderName } = await import('./embed.mjs')
  const { NIGHTLY_PROVIDER } = await import('./nightly-provider.mjs')
  if (embedProviderName !== 'stub' || NIGHTLY_PROVIDER !== 'stub') {
    throw new Error(`test env failed to lock stub providers: embed=${embedProviderName} nightly=${NIGHTLY_PROVIDER}`)
  }
}
