import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { seedWritingBook } from './fixtures/writingBook'
import { writingEnvironment } from './fixtures/writingMetrics'
import { writingProvenance } from './fixtures/writingProvenance'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import type { WritingPane } from './fixtures/writingContract'
import type * as Y from 'yjs'

interface DiagnosticPane extends WritingPane { views: { root: HTMLElement; state: { text: Y.Text } }[]; history: { undoGroups: number[][] } }
interface ExpectedScene { root: HTMLElement; semantic: string }

function sceneRevisions(prefix: number) {
  const normalize = (root: HTMLElement) => {
    const clone = root.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.nv-page').forEach(page => page.replaceWith(...page.childNodes))
    return clone
  }
  const panes = window.writingPanes as unknown as DiagnosticPane[]
  const targets = [0, 999, 500]
  if (!prefix) Reflect.set(window, 'writingDiagnosticExpected', targets.map(scene => ({ root: normalize(panes[0].views[scene].root), semantic: panes[0].views[scene].state.text.toString() })))
  const expected = Reflect.get(window, 'writingDiagnosticExpected') as ExpectedScene[]
  return panes.map(pane => targets.map((scene, index) => {
    const view = pane.views[scene]
    const clone = expected[index].root.cloneNode(true) as HTMLElement
    const first = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT).nextNode()
    if (first && prefix) first.textContent = 'q'.repeat(prefix) + first.textContent
    const latest = window.writingPublications?.filter(publication => publication.sceneId === view.root.dataset.sceneId).at(-1)
    return { domExact: normalize(view.root).innerHTML === clone.innerHTML,
      semanticExact: view.state.text.toString() === 'q'.repeat(prefix) + expected[index].semantic,
      publicationExact: latest?.html === clone.innerHTML }
  }))
}

test('diagnostic oracle: delayed authored publication retains exact final scene revision', async () => {
  const h = await launchWriting('experiment', 2, false)
  try {
    await h.seed({ wordCount: 4, scenes: [{ id: 'a', html: '<p>alpha bravo</p>' }, { id: 'b', html: '<p>charlie delta</p>' }] })
    await h.page.evaluate(() => {
      window.writingPublications = []
      window.addEventListener('message', event => {
        if (typeof event.data?.novalistEditor !== 'string') return
        const message = JSON.parse(event.data.novalistEditor)
        if (message.type === 'contentChanged') window.writingPublications.push(message)
      })
      window.writingPanes[0].select({ scene: 0, offset: 0 }, { scene: 0, offset: 0 })
    })
    const counts = () => h.page.evaluate(() => Array.from(document.querySelectorAll('iframe'), frame => frame.contentWindow!.writingCaptureTelemetry!.sceneIds.length))
    const before = await counts()
    await h.page.keyboard.insertText('q')
    const beforeFlush = await counts()
    await h.frames()[0].evaluate(() => (window as unknown as EditorWindow).flushPendingContentChange())
    await expect.poll(() => h.page.evaluate(() => window.writingPublications.length)).toBe(1)
    expect(await counts()).toEqual([before[0] + 1, before[1]])
    expect(beforeFlush[0] - before[0]).toBeLessThanOrEqual(1)
    const final = await h.page.evaluate(() => ({ scenes: window.writingPanes.map(pane => pane.serialize()[0]),
      semantic: window.writingPanes.map(pane => pane.inspect().deltas[0].map(run => run.insert).join('')), publications: window.writingPublications }))
    expect(final.scenes.every(scene => scene.html === '<p>qalpha bravo</p>')).toBe(true)
    expect(final.semantic).toEqual(['qalpha bravo\n', 'qalpha bravo\n'])
    expect(final.publications).toEqual([{ type: 'contentChanged', sceneId: 'a', html: '<p>qalpha bravo</p>', plainText: 'qalpha bravo' }])
  } finally { await h.close() }
})

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
    await h.page.evaluate(() => {
      window.writingPublications = []
      window.addEventListener('message', event => {
        if (typeof event.data?.novalistEditor !== 'string') return
        const message = JSON.parse(event.data.novalistEditor)
        if (message.type === 'contentChanged') window.writingPublications.push(message)
      })
    })
    await h.page.evaluate(sceneRevisions, 0)
    for (const [modeIndex, name] of ['normal', 'page', 'typewriter', 'page+typewriter'].entries()) {
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
      await h.page.evaluate(() => Reflect.set(window, 'writingDiagnosticPages', Array.from(document.querySelectorAll('iframe'), frame => Array.from(frame.contentDocument!.querySelectorAll('.nv-page')))))
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
      const retainedPages = await h.page.evaluate(() => (Reflect.get(window, 'writingDiagnosticPages') as Element[][]).map(pages => ({ observedAtInputEnd: pages.length, stillConnected: pages.filter(page => page.isConnected).length })))
      const sorted = [...samplesMs].sort((a, b) => a - b)
      await h.page.evaluate(() => { for (const frame of document.querySelectorAll('iframe')) (frame.contentWindow as EditorWindow).flushPendingContentChange() })
      await h.page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
      const revisions = await h.page.evaluate(sceneRevisions, (modeIndex + 1) * 10)
      const authoredState = await h.page.evaluate(() => ({ publications: window.writingPublications.length, historyGroups: (window.writingPanes as unknown as DiagnosticPane[])[0].history.undoGroups.length }))
      const selectedRevisions = revisions
      evidence.modes.push({ name, samplesMs, firstInputMs: samplesMs[0], subsequentInputSamplesMs: samplesMs.slice(1),
        inputP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], capturesStart, capturesAfterMode, capturesAfterInputs, capturesAfterTail,
        inputObservations, authoredState, selectedRevisions,
        delayedObservation: { atInputEnd, atTailEnd, retainedPages, geometryEqual: JSON.stringify(atInputEnd) === JSON.stringify(atTailEnd) } })
      expect(samplesMs).toHaveLength(30)
      expect(samplesMs.every(Number.isFinite)).toBe(true)
      expect(capturesAfterMode).toEqual(capturesStart)
      expect(selectedRevisions.flat().every(scene => scene.domExact && scene.semanticExact && scene.publicationExact)).toBe(true)
      expect(authoredState).toEqual({ publications: (modeIndex + 1) * 30, historyGroups: (modeIndex + 1) * 30 })
    }
  } finally {
    const file = info.outputPath('presentation-diagnostic.json')
    await writeFile(file, JSON.stringify(evidence, null, 2))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(evidence)
    await h.close()
  }
})
