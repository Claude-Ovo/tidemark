import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dev 代理：/viz → 本地 Tidemark 服务，免 CORS；生产走 CloudFront 同源或显式 API base
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/viz': { target: 'http://localhost:3901', changeOrigin: true },
    },
  },
})
