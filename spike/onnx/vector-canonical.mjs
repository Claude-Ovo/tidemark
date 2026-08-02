// 转发正式 canonical 实现（round-2 修 P1-2：digest 不许复制变体）。
// 本地开发经此转发解析到 src/lib；build.ps1 打包时把 src/lib 的实现文件按 basename
// 复制进 zip 根，Lambda 上 './vector-canonical.mjs' 直接命中实体——两条路径同一算法。
export * from '../../src/lib/vector-canonical.mjs'
