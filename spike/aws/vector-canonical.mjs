// 单一实现原则不变，方向自 P0-09 翻转：实现体在 src/lib/vector-canonical.mjs（主服务
// 部署树），本文件只转发。spike 打包时 deploy.ps1 直接把 src/lib 的实现文件收进 zip 根
//（Compress-Archive 按 basename 落位），线上 handler 的 './vector-canonical.mjs' 照常解析。
export * from '../../src/lib/vector-canonical.mjs'
