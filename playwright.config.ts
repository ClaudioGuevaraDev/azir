import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Electron instances own real PTYs and a real window; running them
  // concurrently makes failures hard to attribute and can leave orphan shells.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
});
