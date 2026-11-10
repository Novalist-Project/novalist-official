import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function writingProvenance() {
  const optimized = process.env.NOVALIST_WRITING_OPTIMIZE !== '0'
  const scoped = optimized && process.env.NOVALIST_WRITING_SCOPED !== '0'
  const source = createHash('sha256')
  const files = ['package-lock.json', 'playwright.writing-feasibility.config.ts', 'playwright.writing-layout-profile.config.ts', 'playwright.writing-presentation.config.ts',
    'e2e/writing-feasibility.spec.ts', 'e2e/writing-layout.profile.ts', 'e2e/writing-presentation.spec.ts', 'e2e/writing-focus-scroll.spec.ts', 'e2e/writing-presentation.diagnostic.ts', 'e2e/writing-continuous-paper.spec.ts', 'e2e/writing-css-paper.spec.ts', 'e2e/writing-css-origin.spec.ts',
    ...readdirSync('e2e/fixtures').filter(file => /^(writing|archiveWriting)/.test(file)).map(file => join('e2e/fixtures', file))]
  for (const directory of ['src/renderer/public', 'src/renderer/src/collaboration']) {
    files.push(...readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)))
  }
  for (const file of files.map(file => file.replaceAll('\\', '/')).sort()) { source.update(file); source.update('\0'); source.update(readFileSync(file)); source.update('\0') }
  return {
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: execFileSync('git', ['status', '--porcelain', '--', 'e2e', 'src/renderer/public', 'src/renderer/src/collaboration', 'package-lock.json', 'playwright.writing-feasibility.config.ts', 'playwright.writing-layout-profile.config.ts', 'playwright.writing-presentation.config.ts'], { encoding: 'utf8' }).trim().length > 0,
    sourceSha256: source.digest('hex'),
    adaptations: { optimized, scoped, incrementalPeerInsert: optimized, contentVisibility: optimized, scenePagination: optimized, sceneCapture: scoped, sceneProofingMap: scoped },
    distribution: process.env.NOVALIST_WRITING_DISTRIBUTION === 'extreme' ? 'quarter-book-long-scene' : 'fixed-25000-word-long-scene',
    diagnostic: { layoutTelemetry: process.env.NOVALIST_WRITING_PROFILE === '1', trace: process.env.NOVALIST_WRITING_TRACE === '1' }
  }
}
