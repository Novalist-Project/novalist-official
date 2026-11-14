import { defineConfig } from '@playwright/test'
import feasibility from './playwright.writing-feasibility.config'

export default defineConfig({ ...feasibility, testMatch: 'writing-layout.profile.ts', outputDir: './test-results/writing-layout-profile' })
