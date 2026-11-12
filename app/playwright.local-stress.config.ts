import { defineConfig } from '@playwright/test'
import config from './playwright.config'

export default defineConfig({
  ...config,
  grepInvert: undefined,
  projects: [
    { name: 'writing-benchmarks', testMatch: 'writing-performance.spec.ts' },
    {
      name: 'flake-stress',
      testMatch: ['workspace-windows-regression.spec.ts', 'm68-dictionary-word.spec.ts', 'collaboration-board.spec.ts'],
      grep: /backend restart restores|a word taught|three windows retain|Board POV/,
      repeatEach: 20
    }
  ]
})
