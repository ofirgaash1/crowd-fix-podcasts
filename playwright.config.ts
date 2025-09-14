import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  use: {
    baseURL: 'http://localhost:5000',
    trace: 'on-first-retry'
  },
  retries: 0
});

