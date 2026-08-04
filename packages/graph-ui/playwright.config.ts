import { defineConfig } from '@playwright/test'

const PORT = 7911

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  // startGraphUi serves web/dist, so the SPA must be built before the fixture boots
  webServer: {
    command: 'bun run --cwd web build && bun e2e/server.ts',
    url: `http://127.0.0.1:${PORT}/api/session`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
