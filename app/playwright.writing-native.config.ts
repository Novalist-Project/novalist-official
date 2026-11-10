import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['writing-feature-parity.spec.ts', 'writing-cross-scene-editing.spec.ts', 'writing-appearance.spec.ts', 'writing-book-layout-parity.spec.ts', 'writing-cold-navigation.spec.ts', 'writing-scope-position.spec.ts'],
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: './test-results/writing-native',
  use: { headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure',
    launchOptions: { args: ['--allow-file-access-from-files'] } }
})
