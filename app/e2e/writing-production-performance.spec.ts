import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cpus, release, platform } from 'node:os'
import { writeFileSync } from 'node:fs'
import { seedWritingBook } from './fixtures/writingBook'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

test('production common root handles one million words with bounded typing and traversal memory', async ({ page, context }, testInfo) => {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  const book = await seedWritingBook({ seed: async () => {} }, { sceneCount: 1000, wordCount: 1_000_000, rich: true })
  const readiness = await page.evaluate(scenes => {
    const editor = window as unknown as EditorWindow
    const start = performance.now()
    editor.setWritingContext({ workspaceId: 'large-fixture', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }, 'large-fixture')
    editor.setWritingProjection(scenes.map(scene => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter',
      sceneId: scene.id, html: scene.html, hash: '', revision: 0 })), null)
    editor.focusEditor()
    const point = { sceneId: scenes[500].id, offset: 4, affinity: 'after' as const }
    editor.revealWritingPoint(point)
    return performance.now() - start
  }, book.scenes)
  const samples: number[] = []
  for (let index = 0; index < 60; index++) {
    const duration = await page.evaluate(async () => {
      const start = performance.now()
      document.execCommand('insertText', false, 'x')
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      return performance.now() - start
    })
    samples.push(duration)
  }
  const p95 = [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]
  const cdp = await context.newCDPSession(page)
  const heaps: number[] = []
  for (let round = 0; round < 5; round++) {
    for (let index = 0; index < 1000; index += 20) {
      await page.evaluate(sceneId => (window as unknown as EditorWindow).revealWritingPoint({ sceneId, offset: 0, affinity: 'after' }), book.scenes[index].id)
    }
    await cdp.send('HeapProfiler.collectGarbage')
    heaps.push((await cdp.send('Runtime.getHeapUsage')).usedSize)
  }
  const bounded = heaps.slice(2).every(heap => heap <= heaps[1] * 1.1 + 8 * 1024 * 1024)
  const metrics = {
    os: platform(), release: release(), cpu: cpus()[0].model, browser: context.browser()?.version(),
    scenes: 1000, words: 1_000_000, firstEditReadyMs: readiness, inputP95Ms: p95, samples, heaps
  }
  const path = testInfo.outputPath('production-editor-metrics.json')
  writeFileSync(path, JSON.stringify(metrics, null, 2))
  await testInfo.attach('production-editor-metrics', { path, contentType: 'application/json' })
  expect(p95).toBeLessThan(50)
  expect(bounded).toBe(true)
  await expect(page.locator('[data-writing-scene]')).toHaveCount(1000)
})
