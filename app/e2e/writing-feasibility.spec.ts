import { expect, test } from '@playwright/test'
import { launchWriting } from './fixtures/writingHarness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import './fixtures/writingContract'
import { seedWritingBook } from './fixtures/writingBook'
import { measureWriting, writingEnvironment, type WritingMetrics } from './fixtures/writingMetrics'
import { writeFile } from 'node:fs/promises'

const smallBook = { wordCount: 4, scenes: [
  { id: 'scene-a', html: '<p>alpha bravo</p>' },
  { id: 'scene-b', html: '<p>charlie delta</p>' }
] }

test('original: native selection crosses two scene surfaces', async () => {
  test.fail(true, 'Diagnostic control: selection cannot span separate iframe documents; original RED preserved in the report.')
  const h = await launchWriting('original')
  try {
    await h.seed(smallBook)
    const selected = await h.page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('iframe'))
      const first = frames[0].contentDocument!
      const second = frames[1].contentDocument!
      const start = first.querySelector('#editor p')!.firstChild!
      const end = second.querySelector('#editor p')!.firstChild!
      first.getSelection()!.setBaseAndExtent(start, 6, end, 7)
      return first.getSelection()!.toString()
    })
    expect(selected).toContain('bravo')
    expect(selected).toContain('charlie')
  } finally { await h.close() }
})

test('experiment: boundary Backspace and Delete preserve both scenes', async () => {
  const h = await launchWriting('experiment')
  try {
    await h.seed(smallBook)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 1, offset: 0 }, { scene: 1, offset: 0 }))
    await h.page.keyboard.press('Backspace')
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 11 }, { scene: 0, offset: 11 }))
    await h.page.keyboard.press('Delete')
    const result = await h.page.evaluate(() => ({ scenes: window.writingPanes[0].serialize(), count: window.writingPanes[0].sceneCount() }))
    expect(result.count).toBe(2)
    expect(result.scenes.map(scene => scene.text)).toEqual(['alpha bravo', 'charlie delta'])
  } finally { await h.close() }
})

test('experiment: backward keyboard selection survives scope round trip and redo restores both formatted scenes', async () => {
  const h = await launchWriting('experiment')
  try {
    await h.seed(smallBook)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 1, offset: 7 }, { scene: 1, offset: 7 }))
    for (let index = 0; index < 14; index++) await h.page.keyboard.press('Shift+ArrowLeft')
    const before = await h.frames()[0].evaluate(() => window.getSelection()!.toString())
    expect(before).toContain('bravo')
    expect(before).toContain('charlie')
    const result = await h.page.evaluate(() => {
      const pane = window.writingPanes[0]
      pane.scope([0]); pane.scope([0, 1])
      const selection = document.querySelector('iframe')!.contentWindow!.getSelection()!.toString()
      pane.command('toggleItalic')
      pane.undo()
      const undone = pane.serialize()
      pane.redo()
      return { selection, undone, redone: pane.serialize() }
    })
    expect(result.selection).toBe(before)
    expect(result.undone.map(scene => scene.html)).toEqual(['<p>alpha bravo</p>', '<p>charlie delta</p>'])
    expect(result.redone.every(scene => scene.html.includes('<i>'))).toBe(true)
  } finally { await h.close() }
})

for (const sceneCount of [100, 500, 1000]) {
  test(`experiment: scale ${sceneCount} scenes with two panes and five traversal rounds`, async ({}, testInfo) => {
    test.setTimeout(900_000)
    const h = await launchWriting('experiment', 2)
    const evidence: { environment?: Awaited<ReturnType<typeof writingEnvironment>>; sceneCount: number; wordCount: number; firstEditReadyMs?: number; rounds: WritingMetrics[]; modes: { name: string; metrics: WritingMetrics }[] } = {
      sceneCount, wordCount: sceneCount * 1000, rounds: [], modes: []
    }
    try {
      evidence.environment = await writingEnvironment(h.page)
      const started = performance.now()
      await seedWritingBook(h, { sceneCount, wordCount: evidence.wordCount, rich: true })
      await h.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      evidence.firstEditReadyMs = performance.now() - started
      for (const name of ['normal', 'page', 'typewriter']) {
        await h.page.evaluate(name => {
          for (const frame of document.querySelectorAll('iframe')) {
            const editor = frame.contentWindow as EditorWindow
            editor.setPageView(name === 'page')
            editor.setTypewriterScroll(name === 'typewriter', 'middle')
          }
        }, name)
        for (let sample = 0; sample < 30; sample++) {
          await h.page.evaluate(({ sample, sceneCount }) => {
            const pane = window.writingPanes[sample % 2]
            const scene = sample % 3 === 0 ? 0 : sample % 3 === 1 ? sceneCount - 1 : Math.floor(sceneCount / 2)
            pane.select({ scene, offset: 0 }, { scene, offset: 0 })
            const frame = document.querySelectorAll('iframe')[sample % 2]
            frame.contentDocument!.querySelectorAll('[data-scene-id]')[scene].scrollIntoView()
            // Exercise actual DOM search while the existing engine schedules its analysis work.
            frame.contentDocument!.getElementById('editor')!.textContent!.indexOf('w17x')
          }, { sample, sceneCount })
          await h.page.keyboard.insertText('q')
          await h.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        }
        const metrics = await measureWriting(h.page)
        evidence.modes.push({ name, metrics })
        expect.soft(metrics.editorRuntimeCount).toBe(2)
        expect.soft(metrics.sceneRootCount).toBe(sceneCount * 2)
        expect.soft(metrics.inputSamplesMs.length).toBeGreaterThanOrEqual((evidence.modes.length) * 30)
        expect.soft(metrics.inputP95Ms).toBeLessThan(50)
      }
      for (let round = 0; round < 5; round++) {
        await h.page.evaluate(async sceneCount => {
          for (let scene = 0; scene < sceneCount; scene++) {
            for (const frame of document.querySelectorAll('iframe')) frame.contentDocument!.querySelectorAll('[data-scene-id]')[scene].scrollIntoView()
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          }
        }, sceneCount)
        evidence.rounds.push(await measureWriting(h.page))
      }
      const baseline = evidence.rounds[1]
      for (const metrics of evidence.rounds.slice(2)) {
        expect.soft(metrics.heapUsedBytes).toBeLessThanOrEqual(baseline.heapUsedBytes * 1.1 + 8 * 1024 * 1024)
        expect.soft(metrics.editorRuntimeCount).toBe(2)
        expect.soft(metrics.sceneRootCount).toBe(sceneCount * 2)
        expect.soft(metrics.documentCount).toBeLessThanOrEqual(baseline.documentCount)
      }
    } finally {
      await writeFile(testInfo.outputPath('metrics.json'), JSON.stringify(evidence, null, 2))
      await h.close()
    }
  })
}

test('experiment: select, copy and format prose across protected scene boundaries', async () => {
  const h = await launchWriting('experiment')
  try {
    await h.seed(smallBook)
    const result = await h.page.evaluate(() => {
      const pane = window.writingPanes[0]
      pane.select({ scene: 0, offset: 6 }, { scene: 1, offset: 7 })
      const editor = document.querySelector('iframe')!.contentWindow as EditorWindow
      const selected = editor.getSelection()!.toString()
      const transfer = new DataTransfer()
      editor.document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }))
      pane.command('toggleBold')
      return { selected, copied: transfer.getData('text/plain'), scenes: pane.serialize() }
    })
    expect(result.selected).toContain('bravo')
    expect(result.selected).toContain('charlie')
    expect(result.copied.replace(/\s+/g, ' ').trim()).toBe('bravo charlie')
    expect(result.scenes.map(scene => scene.id)).toEqual(['scene-a', 'scene-b'])
    expect(result.scenes[0].html).toContain('<b>bravo</b>')
    expect(result.scenes[1].html).toContain('<b>charlie</b>')
    expect(result.scenes.every(scene => !scene.html.includes('data-scene-id'))).toBe(true)
  } finally { await h.close() }
})

test('experiment: keyboard deletion preserves empty scene identities and supports compound undo after scope changes', async () => {
  const h = await launchWriting('experiment')
  try {
    await h.seed(smallBook)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 0 }, { scene: 1, offset: 13 }))
    await h.page.keyboard.press('Backspace')
    const deleted = await h.page.evaluate(() => window.writingPanes[0].serialize())
    expect(deleted.map(scene => scene.id)).toEqual(['scene-a', 'scene-b'])
    expect(deleted.map(scene => scene.text)).toEqual(['', ''])
    const restored = await h.page.evaluate(() => {
      const pane = window.writingPanes[0]
      pane.scope([1])
      pane.undo()
      pane.scope([0, 1])
      return pane.serialize()
    })
    expect(restored.map(scene => scene.text)).toEqual(['alpha bravo', 'charlie delta'])
  } finally { await h.close() }
})

test('experiment: local undo preserves an independent replica insertion and synchronizes two panes', async () => {
  const h = await launchWriting('experiment', 2)
  try {
    await h.seed(smallBook)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 5 }, { scene: 0, offset: 5 }))
    await h.page.keyboard.insertText(' LOCAL')
    const result = await h.page.evaluate(() => {
      const pane = window.writingPanes[0]
      pane.capture()
      pane.remoteInsert(0, 0, 'REMOTE ')
      pane.scope([1])
      pane.undo()
      pane.scope([0, 1])
      return window.writingPanes.map(pane => pane.serialize()[0].text)
    })
    expect(result).toEqual(['REMOTE alpha bravo', 'REMOTE alpha bravo'])
  } finally { await h.close() }
})

test('experiment: comments and highlights stay inside their owning scene through undo and serialization', async () => {
  const h = await launchWriting('experiment')
  try {
    await h.seed(smallBook)
    const result = await h.page.evaluate(() => {
      const pane = window.writingPanes[0]
      pane.select({ scene: 0, offset: 6 }, { scene: 1, offset: 7 })
      pane.command('wrapSelectionAsComment')
      const commented = pane.serialize()
      pane.undo()
      pane.select({ scene: 0, offset: 6 }, { scene: 1, offset: 7 })
      pane.command('toggleHighlight')
      return { commented, highlighted: pane.serialize() }
    })
    for (const scenes of [result.commented, result.highlighted]) {
      expect(scenes.map(scene => scene.id)).toEqual(['scene-a', 'scene-b'])
      expect(scenes.map(scene => scene.text)).toEqual(['alpha bravo', 'charlie delta'])
      expect(scenes.every(scene => !scene.html.includes('data-scene-id'))).toBe(true)
    }
    expect(result.commented.every(scene => scene.html.includes('data-comment-id'))).toBe(true)
    expect(result.highlighted.every(scene => scene.html.includes('nv-highlight'))).toBe(true)
  } finally { await h.close() }
})

test('experiment: composition pins its scene and defers a projection change until commit', async () => {
  const h = await launchWriting('experiment')
  try {
    await h.seed(smallBook)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 5 }, { scene: 0, offset: 5 }))
    const session = await h.page.context().newCDPSession(h.page)
    await session.send('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 })
    const pinned = await h.page.evaluate(() => {
      window.writingPanes[0].scope([1])
      return document.querySelector('iframe')!.contentDocument!.querySelector<HTMLElement>('[data-scene-id="scene-a"]')!.hidden
    })
    expect(pinned).toBe(false)
    await session.send('Input.insertText', { text: '漢字' })
    await expect.poll(() => h.page.evaluate(() => window.writingPanes[0].serialize()[0].text)).toBe('alpha漢字 bravo')
    await session.detach()
  } finally { await h.close() }
})
