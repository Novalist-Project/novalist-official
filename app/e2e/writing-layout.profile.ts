import { expect, test } from '@playwright/test'
import { writeFile, readFile } from 'node:fs/promises'
import { launchWriting, type WritingHarness } from './fixtures/writingHarness'
import { snapshotWriting } from './fixtures/writingLayoutSnapshot'
import { seedWritingBook } from './fixtures/writingBook'
import { writingEnvironment } from './fixtures/writingMetrics'
import { writingProvenance } from './fixtures/writingProvenance'
import { startLayoutTrace } from './fixtures/writingLayoutTrace'
import type { LayoutSnapshot } from './fixtures/writingLayoutTelemetry'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import './fixtures/writingLayoutTelemetry'

const book = { wordCount: 4, scenes: [{ id: 'scene-a', html: '<p>alpha bravo</p>' }, { id: 'scene-b', html: '<p>charlie delta</p>' }] }
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test('profile snapshot: dirty DOM and semantic history describe the same captured revision', async () => {
  const h = await launchWriting('experiment', 1, false)
  try {
    await h.seed(book)
    await h.frames()[0].evaluate(() => { document.querySelector('[data-scene-id] p')!.firstChild!.textContent = 'omega bravo' })
    const snapshot = (await snapshotWriting(h.page)).panes[0]
    expect(snapshot.scenes[0].text).toBe('omega bravo')
    expect(snapshot.deltas[0].map(run => run.insert).join('')).toBe('omega bravo\n')
    expect(snapshot.undoGroups).toEqual([[0]])
  } finally { await h.close() }
})

async function observePublications(h: WritingHarness) {
  await h.page.evaluate(() => {
    window.writingPublications = []
    window.addEventListener('message', event => {
      if (typeof event.data?.novalistEditor !== 'string') return
      const message = JSON.parse(event.data.novalistEditor)
      if (message.type === 'contentChanged') window.writingPublications.push({ sceneId: message.sceneId, html: message.html })
    })
  })
}

async function blockIdentities(h: WritingHarness) {
  return h.page.evaluate(() => window.writingPanes.map(pane => pane.inspect().deltas.map(runs => runs.flatMap(run => {
    const blocks: { id: string }[] = run.attributes?.block ? JSON.parse(run.attributes.block) : []
    return blocks.map(block => block.id)
  }))))
}

test('profile invariance: telemetry retains prose, selection, owners, history and publication count', async () => {
  const results: Awaited<ReturnType<typeof snapshotWriting>>[][] = []
  for (const profiling of [false, true]) {
    const h = await launchWriting('experiment', 2, profiling)
    try {
      await h.seed(book)
      await observePublications(h)
      await h.page.evaluate(() => window.writingPanes[0].select({ scene: 1, offset: 7 }, { scene: 0, offset: 6 }))
      const before = await snapshotWriting(h.page)
      const identities = await blockIdentities(h)
      expect(identities.every(pane => new Set(pane.flat()).size === 2)).toBe(true)
      if (profiling) await h.page.evaluate(() => window.__writingLayout.start())
      await h.frames()[0].evaluate(() => (window as unknown as { getCaretPosition(): { line: number; column: number } }).getCaretPosition())
      await h.page.waitForTimeout(1000)
      if (profiling) {
        const telemetry = await h.page.evaluate(() => window.__writingLayout.stop())
        expect(Object.keys(telemetry.spans).length).toBeGreaterThan(0)
      }
      expect(await snapshotWriting(h.page)).toEqual(before)
      expect(await blockIdentities(h)).toEqual(identities)
      await h.page.keyboard.insertText('replacement')
      await h.frames()[0].evaluate(() => (window as unknown as EditorWindow).flushPendingContentChange())
      await expect.poll(() => h.page.evaluate(() => window.writingPublications.length)).toBe(2)
      const changed = await snapshotWriting(h.page)
      expect(changed.panes[0].scenes.map(scene => scene.text)).toEqual(['alpha replacement', ' delta'])
      expect(changed.panes.every(pane => new Set(pane.owners.map(owner => owner.id)).size === 2 && pane.owners.every(owner => owner.connected))).toBe(true)
      await h.page.keyboard.press(`${modifier}+z`)
      const undone = await snapshotWriting(h.page)
      expect(undone.panes[0].scenes.map(scene => scene.text)).toEqual(['alpha bravo', 'charlie delta'])
      await h.page.keyboard.press(`${modifier}+Shift+z`)
      const redone = await snapshotWriting(h.page)
      results.push([before, changed, undone, redone])
    } finally { await h.close() }
  }
  expect(results[1]).toEqual(results[0])
})

async function setMode(h: WritingHarness, name: string) {
  await h.page.evaluate(name => {
    for (const frame of document.querySelectorAll('iframe')) {
      const editor = frame.contentWindow as EditorWindow
      editor.setPageView(name.includes('page'))
      editor.setTypewriterScroll(name.includes('typewriter'), 'middle')
    }
  }, name)
  await h.page.waitForTimeout(1000)
}

async function inputBurst(h: WritingHarness, sceneCount: number) {
  const start = await h.page.evaluate(() => window.writingPanes.map(pane => pane.sampleCount()))
  for (let input = 0; input < 9; input++) {
    await h.page.evaluate(({ input, sceneCount }) => {
      const pane = input % 2
      const scene = Math.floor(input / 3) === 0 ? 0 : Math.floor(input / 3) === 1 ? Math.floor(sceneCount / 2) : sceneCount - 1
      window.writingPanes[pane].select({ scene, offset: input % 3 }, { scene, offset: input % 3 })
      const frame = document.querySelectorAll('iframe')[pane]
      frame.contentDocument!.querySelectorAll('[data-scene-id]')[scene].scrollIntoView()
      frame.contentDocument!.getElementById('editor')!.textContent!.indexOf('w17x')
    }, { input, sceneCount })
    await h.page.keyboard.insertText('q')
    await h.page.waitForTimeout(90)
  }
  await h.page.waitForTimeout(1100)
  return h.page.evaluate(start => window.writingPanes.flatMap((pane, index) => pane.samples().slice(start[index])), start)
}

async function geometry(h: WritingHarness) {
  return h.frames()[0].evaluate(() => {
    const selection = getSelection()!
    const rect = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
    const wrapper = document.getElementById('editor-wrapper')!
    return { top: rect?.top, bottom: rect?.bottom, scrollTop: wrapper.scrollTop, pages: document.querySelectorAll('.nv-page').length }
  })
}

async function enabledServiceProbe(h: WritingHarness) {
  await setMode(h, 'normal')
  await h.frames()[0].evaluate(() => {
    const editor = window as unknown as EditorWindow & {
      NovalistEditorState: { grammarEnabled: boolean }
      setReadabilityEnabled(enabled: boolean): void
      setComposeDimming(enabled: boolean): void
      setDialogueCorrectionConfig(json: string): void
    }
    editor.setComposeDimming(true)
    editor.setReadabilityEnabled(true)
    editor.NovalistEditorState.grammarEnabled = true
    editor.setDialogueCorrectionConfig(JSON.stringify({ enabled: true, ruleFamily: 'en', openQuote: '"', closeQuote: '"', speechVerbs: ['said'] }))
  })
  await h.page.waitForTimeout(1800)
  await h.page.evaluate(() => { window.writingPanes[0].select({ scene: 0, offset: 0 }, { scene: 0, offset: 0 }); window.__writingLayout.start() })
  await h.page.keyboard.insertText('q')
  await h.page.waitForTimeout(1800)
  return { name: 'enabled-services-submission-only', tailMs: 1800, backendAnalysis: false, dimming: true, grammar: true, readability: true, correction: true,
    telemetry: await h.page.evaluate(() => window.__writingLayout.stop()) }
}

for (const sceneCount of [100, 1000]) {
  test(`diagnostic only: layout attribution ${sceneCount} scenes`, async ({}, info) => {
    test.skip(process.env.NOVALIST_WRITING_PROFILE !== '1', 'Explicit profiling flag required.')
    test.setTimeout(300_000)
    const h = await launchWriting('experiment', 2)
    const evidence = { sceneCount, wordCount: sceneCount * 1000, longSceneWords: 25_000,
      provenance: writingProvenance(), environment: await writingEnvironment(h.page), acceptance: false,
      workload: { inputsPerMode: 9, interInputDelayMs: 90, tailMs: 1100, backendAnalysis: false, dimming: false, grammar: false, readability: false },
      modes: [] as object[], enabledServices: null as { name: string; tailMs: number; backendAnalysis: boolean; dimming: boolean; grammar: boolean; readability: boolean; correction: boolean; telemetry: LayoutSnapshot } | null }
    try {
      await seedWritingBook(h, { sceneCount, wordCount: evidence.wordCount, rich: true, longSceneWords: 25_000 })
      await h.page.evaluate(async () => { await Promise.all(Array.from(document.querySelectorAll('iframe')).flatMap(frame => Array.from(frame.contentDocument!.images, image => image.decode()))) })
      for (const name of ['normal', 'page', 'typewriter', 'page+typewriter']) {
        await setMode(h, name)
        const before = await snapshotWriting(h.page)
        const stopTrace = process.env.NOVALIST_WRITING_TRACE === '1' ? await startLayoutTrace(h.page) : null
        await h.page.evaluate(() => { performance.mark('writing-profile-start'); window.__writingLayout.start() })
        const samplesMs = await inputBurst(h, sceneCount)
        const telemetry = await h.page.evaluate(() => { performance.mark('writing-profile-end'); return window.__writingLayout.stop() })
        const trace = stopTrace ? await stopTrace(info.outputPath(`${name}-trace.json`)) : null
        const after = await snapshotWriting(h.page)
        expect(after.panes.map(pane => pane.owners)).toEqual(before.panes.map(pane => pane.owners))
        expect(after.panes[0].scenes).toEqual(after.panes[1].scenes)
        const first = await geometry(h)
        await h.page.waitForTimeout(250)
        const final = await geometry(h)
        const sorted = [...samplesMs].sort((a, b) => a - b)
        evidence.modes.push({ name, samplesMs, inputP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], telemetry, trace,
          endpointGeometryStable: JSON.stringify(first) === JSON.stringify(final), endpointGeometry: final })
        expect(samplesMs).toHaveLength(9)
      }
      evidence.enabledServices = await enabledServiceProbe(h)
    } finally {
      const path = info.outputPath('layout-profile.json')
      await writeFile(path, JSON.stringify(evidence, null, 2))
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(evidence)
      await h.close()
    }
  })
}
