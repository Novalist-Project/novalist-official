import { defineConfig } from '@playwright/test'

export const writingBrowserSpecs = ['writing-feature-parity.spec.ts', 'writing-cross-scene-editing.spec.ts', 'writing-appearance.spec.ts', 'writing-rail-space.spec.ts', 'writing-book-layout-parity.spec.ts', 'writing-cold-navigation.spec.ts', 'writing-scope-position.spec.ts', 'writing-rtl.spec.ts', 'rtl-content.spec.ts', 'rtl-shortcuts.spec.ts', 'arabic-interface.spec.ts', 'editor-interface.spec.ts', 'writing-production-performance.spec.ts']

export default defineConfig({
  testDir: './e2e',
  testMatch: writingBrowserSpecs,
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: './test-results/writing-native',
  use: { headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure',
    launchOptions: { args: ['--allow-file-access-from-files'] } }
})
