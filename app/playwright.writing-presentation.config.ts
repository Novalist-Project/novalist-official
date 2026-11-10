import { defineConfig } from '@playwright/test'
import feasibility from './playwright.writing-feasibility.config'

export default defineConfig({ ...feasibility, testMatch: ['writing-presentation.spec.ts', 'writing-focus-scroll.spec.ts', 'writing-presentation.diagnostic.ts', 'writing-continuous-paper.spec.ts'], outputDir: './test-results/writing-presentation' })
