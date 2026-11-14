import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'writing-feasibility.spec.ts',
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: './test-results/writing-feasibility',
  use: { headless: true, viewport: { width: 1440, height: 1000 } }
})
