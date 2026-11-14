import { defineConfig, devices } from '@playwright/test';

// E2E tests. Point at a running ObservaOne:
//   E2E_BASE_URL=https://observaone.local npm run test:e2e
// Default targets the Vite dev server on :5173 (which needs the API on :8080).
// Set E2E_WEBSERVER=1 to auto-start `npm run dev`.
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(process.env.E2E_WEBSERVER === '1'
    ? { webServer: { command: 'npm run dev', url: baseURL, reuseExistingServer: true, timeout: 120_000 } }
    : {}),
});
