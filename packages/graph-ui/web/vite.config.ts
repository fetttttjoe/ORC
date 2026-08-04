import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Dev: `bun run dev` here, with /api proxied to the running `orc graph` server (7749) — the
// Svelte app is a pure client of the same HTTP surface the legacy page uses, so both UIs can
// run side by side against one server until parity flips the static root.
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
