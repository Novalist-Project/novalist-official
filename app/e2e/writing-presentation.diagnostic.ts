import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { seedWritingBook } from './fixtures/writingBook'
import { writingEnvironment } from './fixtures/writingMetrics'
import { writingProvenance } from './fixtures/writingProvenance'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

test('bounded diagnostic: 1000 scenes, immediate mode transitions and 30 native inputs', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_PRESENTATION_DIAGNOSTIC !== '1', 'Explicit bounded diagnostic flag required.')
  test.setTimeout(300_000)
  const h = await launchWriting('experiment', 2, false)
  const evidence = { provenance: writingProvenance(), environment: await writingEnvironment(h.page), acceptance: false,
    sceneCount: 1000, wordCount: 1_000_000, longSceneWords: 25_000,
    workload: { inputsPerMode: 30, interInputDelayMs: 0, modeSettleMs: 0, tailObservationMs: 1000, telemetry: false, trace: false },
    modes: [] as object[] }
  const captureCounts = () => h.page.evaluate(() => Array.from(document.querySelectorAll('iframe'), frame => frame.contentWindow!.writingCaptureTelemetry!.sceneIds.length))
  try {
    await seedWritingBook(h, { sceneCount: 1000, wordCount: 1_000_000, rich: true, longSceneWords: 25_000 })
    await h.page.evaluate(async () => {
      await Promise.all(Array.from(document.querySelectorAll('iframe')).flatMap(frame => Array.from(frame.contentDocument!.images, image => image.decode())))
    })
    await h.page.waitForFunction(() => Array.from(document.querySelectorAll('iframe')).every(frame => frame.contentDocument!.querySelectorAll('.nv-cc-card').length === 100))
    for (const name of ['normal', 'page', 'typewriter', 'page+typewriter']) {
      const samplesStart = await h.page.evaluate(() => window.writingPanes.map(pane => pane.sampleCount()))
      const capturesStart = await captureCounts()
      await h.page.evaluate(name => {
        for (const frame of document.querySelectorAll('iframe')) {
          const editor = frame.contentWindow as EditorWindow
          editor.setPageView(name.includes('page'))
          editor.setTypewriterScroll(name.includes('typewriter'), 'middle')
        }
      }, name)
      const capturesAfterMode = await captureCounts()
      const inputObservations: object[] = []
      for (let sample = 0; sample < 30; sample++) {
        await h.page.evaluate(sample => {
          const scene = sample % 3 === 0 ? 0 : sample % 3 === 1 ? 999 : 500
          window.writingPanes[sample % 2].select({ scene, offset: 0 }, { scene, offset: 0 })
          const document = window.document.querySelectorAll('iframe')[sample % 2].contentDocument!
          document.querySelectorAll('[data-scene-id]')[scene].scrollIntoView()
          document.getElementById('editor')!.textContent!.indexOf('w17x')
        }, sample)
        const before = await captureCounts()
        await h.page.keyboard.insertText('q')
        await h.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        const after = await captureCounts()
        inputObservations.push({ pane: sample % 2, sceneIndex: sample % 3 === 0 ? 0 : sample % 3 === 1 ? 999 : 500,
          serializedScenes: after.map((count, pane) => count - before[pane]) })
      }
      const samples = await h.page.evaluate(start => window.writingPanes.map((pane, index) => pane.samples().slice(start[index])), samplesStart)
      const samplesMs = Array.from({ length: 30 }, (_, sample) => samples[sample % 2][Math.floor(sample / 2)])
      const capturesAfterInputs = await captureCounts()
      const geometry = () => h.page.evaluate(() => Array.from(document.querySelectorAll('iframe'), frame => {
        const selected = frame.contentWindow!.getSelection()!
        const rect = selected.rangeCount ? selected.getRangeAt(0).getBoundingClientRect() : null
        return { pages: frame.contentDocument!.querySelectorAll('.nv-page').length, top: rect?.top ?? null,
          bottom: rect?.bottom ?? null, scrollTop: frame.contentDocument!.getElementById('editor-wrapper')!.scrollTop }
      }))
      const atInputEnd = await geometry()
      await h.page.waitForTimeout(1000)
      const atTailEnd = await geometry()
      const capturesAfterTail = await captureCounts()
      const sorted = [...samplesMs].sort((a, b) => a - b)
      evidence.modes.push({ name, samplesMs, firstInputMs: samplesMs[0], subsequentInputSamplesMs: samplesMs.slice(1),
        inputP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], capturesStart, capturesAfterMode, capturesAfterInputs, capturesAfterTail,
        inputObservations, delayedObservation: { atInputEnd, atTailEnd, geometryEqual: JSON.stringify(atInputEnd) === JSON.stringify(atTailEnd) } })
      expect(samplesMs).toHaveLength(30)
      expect(samplesMs.every(Number.isFinite)).toBe(true)
      expect(capturesAfterMode).toEqual(capturesStart)
      expect(capturesAfterTail).toEqual(capturesAfterInputs)
    }
  } finally {
    const file = info.outputPath('presentation-diagnostic.json')
    await writeFile(file, JSON.stringify(evidence, null, 2))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(evidence)
    await h.close()
  }
})
