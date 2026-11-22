import { defineConfig } from '@playwright/test'
import { writingResearchSpecs } from './e2e/fixtures/writingResearchSpecs'
import writingBrowser, { writingBrowserSpecs } from './playwright.writing-native.config'

/**
 * The system clipboard is off limits for the whole run.
 *
 * Every spec builds its Electron environment from `process.env`, whether it
 * goes through the harness or launches the app itself, so setting this here is
 * the one place that covers all of them. See the handler in main/dialogs.ts for
 * what it costs to get this wrong.
 */
process.env.NOVALIST_NO_CLIPBOARD = '1'

export default defineConfig({
  testDir: './e2e',
  testIgnore: writingResearchSpecs,
  grepInvert: /@local-stress/,
  globalSetup: require.resolve('./e2e/desktopSetup.ts'),
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'playwright-report/results.json' }]]
    : [['list']],
  projects: [
    { name: 'app', testIgnore: [...writingResearchSpecs, ...writingBrowserSpecs] },
    { name: 'writing-browser', testMatch: writingBrowserSpecs,
      timeout: writingBrowser.timeout, use: writingBrowser.use }
  ],
  use: {
    trace: 'retain-on-failure'
  }
})
