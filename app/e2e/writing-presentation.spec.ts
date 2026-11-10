import { expect, test } from '@playwright/test'
import { launchWriting, type WritingHarness } from './fixtures/writingHarness'
import { installPresentationProbe } from './fixtures/writingPresentationProbe'
import { snapshotWriting } from './fixtures/writingLayoutSnapshot'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import type * as Y from 'yjs'
import type { WritingPane } from './fixtures/writingContract'
import type { FixtureBook } from './fixtures/writingBook'

interface TransactionPane extends WritingPane { views: { state: { doc: Y.Doc; text: Y.Text } }[] }

const book = { wordCount: 2500, scenes: [
  { id: 'scene-a', html: '<p>alpha <b>bravo</b></p><p><span class="nv-comment" data-comment-id="note">comment</span></p>' },
  { id: 'scene-b', html: '<p>charlie delta</p>' },
  { id: 'empty', html: '<p><br></p>' },
  { id: 'long', html: Array.from({ length: 40 }, () => '<p>long synthetic paragraph with enough words to span several pages.</p>').join('') },
  ...Array.from({ length: 20 }, (_, index) => ({ id: `extra-${index}`, html: '<p>untouched synthetic prose</p>' }))
] }
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function setup(fixture: FixtureBook = book): Promise<WritingHarness> {
  const h = await launchWriting('experiment', 2, false)
  await h.seed(fixture)
  await h.page.evaluate(installPresentationProbe)
  return h
}

for (const change of ['remove', 'reorder', 'partial-remove'] as const) {
  test(`presentation review I1: extra same-node ${change} survives an owned append and throw`, async () => {
    const fixture = { wordCount: 3, scenes: [{ id: 'a', html: change === 'reorder' ? '<p>alpha</p><p>bravo</p>' : '<p>alpha bravo</p>' }, { id: 'b', html: '<p>charlie</p>' }] }
    const h = await setup(fixture)
    try {
      await h.frames()[0].evaluate(change => {
        const append = Element.prototype.append
        Element.prototype.append = function (...nodes) {
          if (change === 'partial-remove' && this.classList.contains('nv-page') && nodes.some(node => node instanceof Element && node.matches('p'))) {
            (nodes[0] as Element).remove()
            throw new Error('Synthetic same-node mutation')
          }
          append.apply(this, nodes)
          if (!this.classList.contains('nv-page') || !nodes.some(node => node instanceof Element && node.matches('p'))) return
          if (change === 'remove') (nodes[0] as Element).remove()
          else this.prepend(nodes.at(-1) as Node)
          throw new Error('Synthetic same-node mutation')
        }
        try { (window as unknown as EditorWindow).setPageView(true) }
        catch (error) { if (!(error instanceof Error) || error.message !== 'Synthetic same-node mutation') throw error }
        finally { Element.prototype.append = append }
      }, change)
      await flush(h)
      const after = await snapshotWriting(h.page)
      const html = change === 'reorder' ? '<p>bravo</p><p>alpha</p>' : ''
      expect(after.panes[0].scenes[0].html).toBe(html)
      expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
      expect(after.panes[1].deltas).toEqual(after.panes[0].deltas)
      expect(after.panes[0].deltas[0].map(run => run.insert).join('')).toBe(change === 'reorder' ? 'bravo\nalpha\n' : '')
      expect(after.panes[0].undoGroups).toEqual([[0]])
      expect(after.publications).toEqual([{ sceneId: 'a', html }])
      expect(await h.page.evaluate(() => window.writingWork.captures)).toBe(1)
      await h.page.evaluate(() => window.writingPanes[0].undo())
      expect((await snapshotWriting(h.page)).panes[0].scenes.map(scene => scene.html)).toEqual(fixture.scenes.map(scene => scene.html))
    } finally { await h.close() }
  })
}

test('presentation review I2: pending same-scene local content publishes once after a peer insertion', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      const peer = document.querySelectorAll('iframe')[1].contentDocument!
      peer.querySelector('[data-scene-id="scene-b"] p')!.firstChild!.textContent = 'queued local delta'
      window.writingPanes[0].remoteInsert(1, 0, 'REMOTE ')
      window.writingPanes[1].capture()
    })
    await flush(h)
    const after = await snapshotWriting(h.page)
    expect(after.panes[0].scenes[1].html).toBe('<p>REMOTE queued local delta</p>')
    expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
    expect(after.panes[0].deltas[1].map(run => run.insert).join('')).toBe('REMOTE queued local delta\n')
    expect(after.panes[1].deltas).toEqual(after.panes[0].deltas)
    expect(after.panes[0].undoGroups).toEqual([[1]])
    expect(after.publications).toEqual([{ sceneId: 'scene-b', html: '<p>REMOTE queued local delta</p>' }])
    await flush(h)
    expect(await h.page.evaluate(() => window.writingPublications)).toEqual(after.publications)
  } finally { await h.close() }
})

test('presentation review I2: a pure peer insertion produces no authored publication or undo group', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => window.writingPanes[0].remoteInsert(1, 0, 'REMOTE '))
    await flush(h)
    const after = await snapshotWriting(h.page)
    expect(after.panes[0].scenes[1].html).toBe('<p>REMOTE charlie delta</p>')
    expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
    expect(after.panes[1].deltas).toEqual(after.panes[0].deltas)
    expect(after.panes[0].undoGroups).toEqual([])
    expect(after.publications).toEqual([])
    expect(await h.page.evaluate(() => window.writingWork.captures)).toBe(0)
  } finally { await h.close() }
})

for (const direct of [true, false]) {
  test(`presentation review N1: ${direct ? 'direct capture and delivery' : 'ordinary flush'} does not publish a later remote echo`, async () => {
    const h = await setup()
    try {
      await h.page.evaluate(direct => {
        window.writingPanes[1].select({ scene: 1, offset: 0 }, { scene: 1, offset: 0 })
        const editor = document.querySelectorAll('iframe')[1].contentWindow as EditorWindow & { sendMessage(message: object): void }
        editor.document.querySelector('[data-scene-id="scene-b"] p')!.firstChild!.textContent = 'already captured local delta'
        window.writingPanes[1].capture()
        if (direct) {
          const change = editor.capturePendingContentChange()
          if (!change || change.html !== '<p>already captured local delta</p>') throw new Error('Expected the local revision to be captured.')
          editor.sendMessage({ type: 'contentChanged', ...change })
        } else editor.flushPendingContentChange()
        window.writingPanes[0].remoteInsert(1, 0, 'REMOTE ')
      }, direct)
      await flush(h)
      const after = await snapshotWriting(h.page)
      expect(after.panes[0].scenes[1].html).toBe('<p>REMOTE already captured local delta</p>')
      expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
      expect(after.panes[0].deltas[1].map(run => run.insert).join('')).toBe('REMOTE already captured local delta\n')
      expect(after.panes[1].deltas).toEqual(after.panes[0].deltas)
      expect(after.panes[0].undoGroups).toEqual([[1]])
      expect(after.publications).toEqual([{ sceneId: 'scene-b', html: '<p>already captured local delta</p>' }])
      await flush(h)
      expect(await h.page.evaluate(() => window.writingPublications)).toEqual(after.publications)
    } finally { await h.close() }
  })
}

test('presentation review N1: direct capture preserves another owner queued in the same observer batch', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      window.writingPanes[1].select({ scene: 1, offset: 0 }, { scene: 1, offset: 0 })
      const editor = document.querySelectorAll('iframe')[1].contentWindow as EditorWindow & { sendMessage(message: object): void }
      editor.document.querySelector('[data-scene-id="scene-b"] p')!.firstChild!.textContent = 'already captured local delta'
      window.writingPanes[1].capture()
      editor.document.querySelector('[data-scene-id="scene-a"] p')!.firstChild!.textContent = 'queued owner '
      const change = editor.capturePendingContentChange()
      if (!change) throw new Error('Expected the direct local revision.')
      editor.sendMessage({ type: 'contentChanged', ...change })
      window.writingPanes[0].remoteInsert(1, 0, 'REMOTE ')
    })
    await flush(h)
    const after = await snapshotWriting(h.page)
    expect(after.panes[0].scenes[0].html).toBe('<p>queued owner <b>bravo</b></p><p><span class="nv-comment" data-comment-id="note">comment</span></p>')
    expect(after.panes[0].scenes[1].html).toBe('<p>REMOTE already captured local delta</p>')
    expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
    expect(after.panes[1].deltas).toEqual(after.panes[0].deltas)
    expect(after.panes[0].undoGroups).toEqual([[1], [0]])
    expect(after.publications).toEqual([
      { sceneId: 'scene-b', html: '<p>already captured local delta</p>' },
      { sceneId: 'scene-a', html: '<p>queued owner <b>bravo</b></p><p><span class="nv-comment" data-comment-id="note">comment</span></p>' }
    ])
  } finally { await h.close() }
})

async function flush(h: WritingHarness): Promise<void> {
  await h.page.evaluate(() => {
    for (const pane of window.writingPanes) pane.capture()
    for (const frame of document.querySelectorAll('iframe')) (frame.contentWindow as EditorWindow).flushPendingContentChange()
  })
  await h.page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
}

for (const direction of ['forward', 'backward', 'caret'] as const) {
  test(`presentation: ${direction} native selection survives repeated two-pane page changes without content work`, async () => {
    const h = await setup()
    try {
      await h.page.evaluate(direction => {
        const a = { scene: direction === 'backward' ? 1 : 0, offset: 3 }
        const f = direction === 'caret' ? a : { scene: direction === 'backward' ? 0 : 1, offset: 7 }
        window.writingPanes[0].select(a, f)
        window.writingPanes[1].select({ scene: 2, offset: 0 }, { scene: 2, offset: 0 })
      }, direction)
      const before = await snapshotWriting(h.page)
      const raw = await h.page.evaluate(() => window.writingPanes.map(pane => pane.inspect()))
      const work = await h.page.evaluate(() => structuredClone(window.writingWork))
      const serialized = await h.page.evaluate(() => Array.from(document.querySelectorAll('iframe'), frame => frame.contentWindow!.writingCaptureTelemetry!.sceneIds.length))
      await h.page.evaluate(() => {
        for (const frame of document.querySelectorAll('iframe')) {
          const editor = frame.contentWindow as EditorWindow
          for (const enabled of [true, false, true, true]) editor.setPageView(enabled)
          editor.repaginatePageView()
        }
      })
      await flush(h)
      const after = await snapshotWriting(h.page)
      expect(after).toEqual(before)
      expect(await h.page.evaluate(() => window.writingPanes.map(pane => pane.inspect()))).toEqual(raw)
      const final = await h.page.evaluate(() => window.writingWork)
      expect(final.captures - work.captures).toBe(0)
      expect(final.transactions - work.transactions).toBe(0)
      expect(final.reads).toEqual(work.reads)
      expect(await h.page.evaluate(() => Array.from(document.querySelectorAll('iframe'), frame => frame.contentWindow!.writingCaptureTelemetry!.sceneIds.length))).toEqual(serialized)
      expect(await h.page.evaluate(() => Array.from(document.querySelectorAll('iframe')).every((frame, pane) => Array.from(frame.contentDocument!.querySelectorAll('[data-scene-id]')).every((root, scene) => root === window.writingOwnerNodes[pane][scene] && root.isConnected)))).toBe(true)
      await h.page.evaluate(() => window.writingPanes[0].select({ scene: 1, offset: 2 }, { scene: 1, offset: 2 }))
      const inputStart = await h.page.evaluate(() => structuredClone(window.writingWork))
      await h.page.keyboard.insertText('Q')
      await flush(h)
      const inputWork = await h.page.evaluate(() => window.writingWork)
      expect(inputWork.captures - inputStart.captures).toBe(1)
      expect(inputWork.transactions - inputStart.transactions).toBe(2)
      expect(inputWork.changed - inputStart.changed).toBe(1)
      expect(inputWork.reads[0] - inputStart.reads[0]).toBeLessThanOrEqual(4)
      expect(await h.page.evaluate(serialized => Array.from(document.querySelectorAll('iframe'), (frame, pane) => frame.contentWindow!.writingCaptureTelemetry!.sceneIds.length - serialized[pane]), serialized)).toEqual([1, 0])
      expect(await h.page.evaluate(() => window.writingPublications)).toEqual([{ sceneId: 'scene-b', html: '<p>chQarlie delta</p>' }])
      await h.page.keyboard.press(`${modifier}+z`)
      expect((await snapshotWriting(h.page)).panes[0].scenes).toEqual(before.panes[0].scenes)
      await h.page.keyboard.press(`${modifier}+Shift+z`)
      expect((await snapshotWriting(h.page)).panes[0].undoGroups).toEqual([[1]])
    } finally { await h.close() }
  })
}

for (const order of ['edit-layout', 'layout-edit', 'mixed', 'throw', 'composition'] as const) {
  test(`presentation: queued real character, attribute and child edits survive ${order}`, async () => {
    const h = await setup()
    try {
      const before = await snapshotWriting(h.page)
      await h.page.evaluate(order => {
        const pane = window.writingPanes[0]
        pane.select({ scene: 1, offset: 2 }, { scene: 1, offset: 2 })
        const editor = document.querySelector('iframe')!.contentWindow as EditorWindow & { NovalistEditorState: { isComposing: boolean } }
        const root = editor.document.querySelector('[data-scene-id="scene-b"]')!
        const edit = () => {
          root.querySelector('p')!.firstChild!.textContent = 'edited delta'
          root.querySelector('p')!.setAttribute('data-style-id', 'authored')
          const child = editor.document.createElement('p')
          child.textContent = 'new child'
          root.append(child)
        }
        if (order === 'layout-edit') editor.setPageView(true)
        if (order === 'composition') root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        edit()
        if (order === 'throw') {
          const block = root.querySelector('p')!
          Object.defineProperty(block, 'offsetHeight', { configurable: true, get() { throw new Error('Synthetic layout failure') } })
          try { editor.setPageView(true) } catch (error) {
            if (!(error instanceof Error) || error.message !== 'Synthetic layout failure') throw error
          } finally { delete (block as unknown as { offsetHeight?: number }).offsetHeight }
        } else if (order !== 'layout-edit') editor.setPageView(true)
        if (order === 'mixed') { root.querySelector('p')!.firstChild!.textContent = 'edited delta'; editor.setPageView(false); editor.setPageView(true) }
        if (order === 'composition') {
          editor.NovalistEditorState.isComposing = false
          root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        } else pane.capture()
      }, order)
      await expect.poll(() => h.page.evaluate(() => window.writingPanes[0].inspect().undoGroups)).toEqual([[1]])
      await flush(h)
      const after = await snapshotWriting(h.page)
      expect(after.panes[0].scenes[1].html).toBe('<p data-style-id="authored">edited delta</p><p>new child</p>')
      expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
      expect(after.panes[1].deltas).toEqual(after.panes[0].deltas)
      expect(after.publications).toHaveLength(1)
      const work = await h.page.evaluate(() => window.writingWork)
      expect(work.captures).toBe(1)
      expect(work.transactions).toBe(2)
      await h.page.keyboard.press(`${modifier}+z`)
      expect((await snapshotWriting(h.page)).panes[0].scenes).toEqual(before.panes[0].scenes)
    } finally { await h.close() }
  })
}

test('presentation: unrelated transactions do not read or restore either selected scene', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      window.writingPanes[0].select({ scene: 0, offset: 3 }, { scene: 0, offset: 3 })
      window.writingPanes[1].select({ scene: 1, offset: 2 }, { scene: 1, offset: 6 })
    })
    const before = await snapshotWriting(h.page)
    const work = await h.page.evaluate(() => structuredClone(window.writingWork))
    await h.page.evaluate(() => window.writingPanes[0].remoteInsert(3, 0, 'REMOTE '))
    const after = await h.page.evaluate(() => window.writingWork)
    expect(after.snapshots).toEqual(work.snapshots)
    expect(after.restores).toEqual(work.restores)
    expect(after.reads.map((count, i) => count - work.reads[i])).toEqual([2, 2])
    expect(after.readsByScene.map((counts, pane) => counts.slice(0, 3).map((count, scene) => count - work.readsByScene[pane][scene]))).toEqual([[0, 0, 0], [0, 0, 0]])
    expect((await snapshotWriting(h.page)).panes.map(pane => pane.selection)).toEqual(before.panes.map(pane => pane.selection))
  } finally { await h.close() }
})

test('presentation: delayed repagination and focus decoration leave no content work or authored class', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      window.writingPanes[0].select({ scene: 0, offset: 3 }, { scene: 0, offset: 3 })
      for (const frame of document.querySelectorAll('iframe')) (frame.contentWindow as EditorWindow).setPageView(true)
    })
    const before = await snapshotWriting(h.page)
    const work = await h.page.evaluate(() => structuredClone(window.writingWork))
    await Promise.all(h.frames().map(frame => frame.evaluate(async () => {
      const editor = window as unknown as EditorWindow & { schedulePageViewRepaginate(): void; setComposeDimming(value: boolean): void }
      const root = document.getElementById('editor')!
      const first = root.querySelector('.nv-page')!
      const completed = new Promise<void>(resolve => {
        const observer = new MutationObserver(() => { if (!first.isConnected) { observer.disconnect(); resolve() } })
        observer.observe(root, { childList: true, subtree: true })
      })
      editor.setComposeDimming(true)
      editor.schedulePageViewRepaginate()
      await completed
    })))
    await flush(h)
    expect(await snapshotWriting(h.page)).toEqual(before)
    const after = await h.page.evaluate(() => window.writingWork)
    expect(after.captures).toBe(work.captures)
    expect(after.transactions).toBe(work.transactions)
    expect(after.reads).toEqual(work.reads)
    await h.page.keyboard.insertText('Q')
    await flush(h)
    const edited = await snapshotWriting(h.page)
    expect(edited.panes[0].undoGroups).toEqual([[0]])
    expect(JSON.stringify(edited.panes[0].deltas)).not.toContain('nv-focus-block')
    expect(edited.publications).toHaveLength(1)
  } finally { await h.close() }
})

test('presentation: reentrant real mutations and an exception remain authored while moving a wrapper', async () => {
  const h = await setup()
  try {
    await h.frames()[0].evaluate(() => {
      const root = document.getElementById('editor')!
      const scene = root.querySelector('[data-scene-id="scene-b"]')!
      const append = scene.append.bind(scene)
      scene.append = (...nodes) => {
        append(...nodes)
        scene.querySelector('p')!.setAttribute('data-style-id', 'authored')
        scene.querySelector('p')!.firstChild!.textContent = 'reentrant delta'
        const child = document.createElement('p'); child.textContent = 'new reentrant child'; append(child)
        throw new Error('Synthetic reentrant failure')
      }
      try { (window as unknown as EditorWindow).setPageView(true) } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Synthetic reentrant failure') throw error
      } finally { scene.append = append }
    })
    await flush(h)
    const after = await snapshotWriting(h.page)
    expect(after.panes[0].scenes[1].html).toBe('<p data-style-id="authored">reentrant delta</p><p>new reentrant child</p>')
    expect(after.panes[0].undoGroups).toEqual([[1]])
    expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
    expect(after.publications).toHaveLength(1)
  } finally { await h.close() }
})

test('presentation: queued local content survives a peer render in another scene without echo publication', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      const peer = document.querySelectorAll('iframe')[1].contentDocument!
      peer.querySelector('[data-scene-id="scene-b"] p')!.firstChild!.textContent = 'queued local delta'
      window.writingPanes[0].remoteInsert(0, 0, 'REMOTE ')
      window.writingPanes[1].capture()
    })
    await flush(h)
    const after = await snapshotWriting(h.page)
    expect(after.panes[0].scenes[0].text).toBe('REMOTE alpha bravocomment')
    expect(after.panes[0].scenes[1].text).toBe('queued local delta')
    expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
    expect(after.panes[0].undoGroups).toEqual([[1]])
    expect(after.publications).toEqual([{ sceneId: 'scene-b', html: '<p>queued local delta</p>' }])
  } finally { await h.close() }
})

for (const container of ['section', 'editor'] as const) {
  test(`presentation: ${container} selection endpoint preserves remote anchors and active publication`, async () => {
    const h = await setup()
    try {
      await h.page.evaluate(container => {
        const pane = window.writingPanes[0]
        const frame = document.querySelector('iframe')!
        const root = frame.contentDocument!.getElementById('editor')!
        const sections = root.querySelectorAll('[data-scene-id]')
        const selected = frame.contentWindow!.getSelection()!
        selected.setBaseAndExtent(sections[1].firstChild!.firstChild!, 6, container === 'editor' ? root : sections[0], container === 'editor' ? 0 : 1)
        window.writingPanes[1].select({ scene: 1, offset: 3 }, { scene: 1, offset: 3 })
        pane.remoteInsert(0, 0, 'XY')
      }, container)
      const after = await snapshotWriting(h.page)
      expect(after.panes[0].selection.anchor).toEqual({ sceneId: 'scene-b', offset: 6 })
      expect(after.panes[0].selection.focus).toEqual({ sceneId: 'scene-a', offset: container === 'editor' ? 2 : 13 })
      expect(after.panes[1].selection.anchor).toEqual({ sceneId: 'scene-b', offset: 3 })
      await h.page.evaluate(container => {
        const root = document.querySelector('iframe')!.contentDocument!.getElementById('editor')!
        const section = root.querySelector('[data-scene-id="scene-b"]')!
        root.ownerDocument.getSelection()!.setBaseAndExtent(container === 'editor' ? root : section, container === 'editor' ? 1 : 0, container === 'editor' ? root : section, container === 'editor' ? 1 : 0)
      }, container)
      expect(await h.page.evaluate(() => window.writingPanes[0].activeScene())).toBe('scene-b')
      await h.frames()[0].evaluate(() => {
        document.querySelector('[data-scene-id="scene-b"] p')!.firstChild!.textContent = 'authored delta'
        const editor = window as unknown as EditorWindow & { capturePendingContentChange(previous?: string): { sceneId: string } | null }
        const change = editor.capturePendingContentChange() as { sceneId?: string } | null
        if (change?.sceneId !== 'scene-b') throw new Error('Container focus failed scene capture.')
      })
      await flush(h)
      expect((await snapshotWriting(h.page)).panes[0].scenes[1].text).toBe('authored delta')
    } finally { await h.close() }
  })
}

test('presentation: transaction-keyed snapshots retain backward cross-scene anchors during nested transactions', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      const panes = window.writingPanes as unknown as TransactionPane[]
      panes[0].select({ scene: 1, offset: 6 }, { scene: 0, offset: 3 })
      panes[1].select({ scene: 1, offset: 3 }, { scene: 1, offset: 3 })
      const [a, b] = panes[0].views.map(view => view.state)
      a.doc.once('beforeTransaction', () => b.doc.transact(() => b.text.insert(0, 'Z'), 'remote'))
      a.doc.transact(() => a.text.insert(0, 'XY'), 'remote')
    })
    const after = await snapshotWriting(h.page)
    expect(after.panes[0].selection.anchor).toEqual({ sceneId: 'scene-b', offset: 7 })
    expect(after.panes[0].selection.focus).toEqual({ sceneId: 'scene-a', offset: 5 })
    expect(after.panes[1].selection.anchor).toEqual({ sceneId: 'scene-b', offset: 4 })
    expect(after.panes[0].undoGroups).toEqual([])
    expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
  } finally { await h.close() }
})
