import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The worker serves the built dashboard; in dev, Vite proxies API calls to it.
const workerPort = process.env.PACE_MEM_PORT ?? '37800'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // Assets are referenced relative to index.html, so any mount path works.
  base: './',
  build: {
    outDir: '../plugin/dashboard',
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${workerPort}`, changeOrigin: true } },
  },
})
