import { defineConfig } from '@playwright/test'
import config from './playwright.config'
import { writingResearchSpecs } from './e2e/fixtures/writingResearchSpecs'

export default defineConfig({
  ...config,
  testIgnore: [],
  testMatch: writingResearchSpecs,
  outputDir: './test-results/writing-research'
})
