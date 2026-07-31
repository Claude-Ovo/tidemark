// 测试前置 env（必须是测试文件的第一个 import——ESM 按 import 顺序执行模块体，
// 这里的赋值先于任何读 env 的模块加载）：套件锁 stub provider，绝不误打真 Bedrock。
process.env.EMBED_PROVIDER ??= 'stub'
process.env.DREAM_PROVIDER ??= 'stub'
process.env.TIDEMARK_DEV_INSECURE ??= '1'
