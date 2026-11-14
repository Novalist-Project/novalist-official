import { defineConfig } from '@playwright/test'
import feasibility from './playwright.writing-feasibility.config'

export default defineConfig({ ...feasibility, testMatch: ['writing-presentation.spec.ts', 'writing-focus-scroll.spec.ts', 'writing-presentation.diagnostic.ts', 'writing-continuous-paper.spec.ts', 'writing-css-paper.spec.ts', 'writing-css-origin.spec.ts', 'writing-page-flow.spec.ts', 'writing-fragments.spec.ts', 'writing-fragment-zoom.spec.ts', 'writing-surface.spec.ts', 'writing-comments.spec.ts', 'writing-fragment-adapter.spec.ts', 'writing-fragment-layout.spec.ts', 'writing-fragment-paragraph.spec.ts'], outputDir: './test-results/writing-presentation' })
