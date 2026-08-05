import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dev 代理：/viz → 本地 Tidemark 服务。凭证注入发生在【代理层】而非页面代码——
// 一审 P0-1：浏览器 bundle 零密钥。生产同构：CloudFront 把 /viz/* 转发 API Gateway 时
// 由 origin custom header 贴只读 viz key（scope='viz'，进不了工具面），页面仍零凭证。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/viz': {
        target: 'http://localhost:3901',
        changeOrigin: true,
        headers: { 'x-tidemark-auth': process.env.TIDEMARK_VIZ_KEY ?? 'viz-demo-key' },
      },
    },
  },
})
