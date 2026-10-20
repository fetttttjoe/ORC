import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Dev: `bun run dev` here, with /api proxied to the running `orc graph` server (7749)
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: { $lib: path.resolve(import.meta.dirname, 'src/lib') },
  },
  server: {
    port: 5199,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7749', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
