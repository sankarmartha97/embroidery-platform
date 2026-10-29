import { defineConfig, devices } from '@playwright/test';

// Performance checks (not part of `npm run e2e`): E2E_PERF=1 npm run perf
export default defineConfig({
  testDir: './e2e/perf',
  testMatch: '**/*.perf.js',
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5001',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
});
