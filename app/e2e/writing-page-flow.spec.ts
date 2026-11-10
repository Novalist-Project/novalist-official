import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { installPresentationProbe } from './fixtures/writingPresentationProbe'
import { snapshotWriting } from './fixtures/writingLayoutSnapshot'
import { writingProvenance } from './fixtures/writingProvenance'
import type { WritingPresentation } from './fixtures/writingPresentation'
import type { WritingPane } from './fixtures/writingContract'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

interface FlowPane extends WritingPane { presentation: WritingPresentation }

const html = '<p>opening</p><p style="margin:1em 0 !important;padding:0.5em !important;background:rgb(240, 220, 200)">alpha</p>bravo <em>inline</em><p>charlie</p>'

test('page flow fields preserve exact content, selection, copy and mixed authored edits', async () => {
  const h = await launchWriting('experiment', 2, false)
  try {
    await h.seed({ wordCount: 5, scenes: [{ id: 'owner', html }] })
    await h.page.evaluate(installPresentationProbe)
    const before = await snapshotWriting(h.page)
    const result = await h.page.evaluate(() => {
      const pane = window.writingPanes[0] as FlowPane
      if (typeof pane.presentation?.spacing !== 'function') return { available: false }
      const doc = document.querySelector('iframe')!.contentDocument!
      const root = doc.querySelector('[data-scene-id]')!
      const block = root.children[1]
      const nodes = Array.from(root.childNodes)
      const initialDelta = JSON.stringify(pane.inspect().deltas)
      const selection = doc.getSelection()!
      selection.setBaseAndExtent(root, 4, root, 1)
      pane.presentation.spacing(block, 'after', 153)
      pane.capture()
      const deltaUnchanged = JSON.stringify(pane.inspect().deltas) === initialDelta
      const serialized = pane.serialize()[0].html
      const pureWork = { changed: window.writingWork.changed, captures: window.writingWork.captures, undo: pane.inspect().undoGroups }
      const endpoints = [selection.anchorNode === root, selection.anchorOffset, selection.focusNode === root, selection.focusOffset]
      selection.setBaseAndExtent(root, 0, root, root.childNodes.length)
      const transfer = new DataTransfer()
      root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }))
      const copied = { html: transfer.getData('text/html'), text: transfer.getData('text/plain') }
      block.setAttribute('title', 'authored')
      block.firstChild!.textContent = 'changed'
      pane.presentation.spacing(block, 'after', 170)
      pane.presentation.spacing(block, 'after', null)
      pane.capture()
      return { available: true, deltaUnchanged, serialized, pureWork, endpoints, copied,
        connected: nodes.every((node, index) => node.isConnected && root.childNodes[index] === node) }
    })
    expect(result.available).toBe(true)
    expect(result.serialized).toBe(html)
    expect(result.deltaUnchanged).toBe(true)
    expect(result.pureWork).toEqual({ changed: 0, captures: 0, undo: [] })
    expect(result.endpoints).toEqual([true, 4, true, 1])
    expect(result.copied).toEqual({ html, text: 'openingalphabravo inlinecharlie' })
    expect(result.connected).toBe(true)
    const after = await snapshotWriting(h.page)
    expect(after.panes[0].scenes[0].html).toBe(html.replace('>alpha</p>', ' title="authored">changed</p>'))
    expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
    expect(after.panes[0].undoGroups).toEqual([[0]])
    await h.page.evaluate(() => window.writingPanes[0].undo())
    expect((await snapshotWriting(h.page)).panes[0].scenes).toEqual(before.panes[0].scenes)
  } finally { await h.close() }
})

for (const interruption of ['none', 'before', 'after'] as const) {
  test(`page flow owned field drains preserve reentrant mutations: ${interruption}`, async () => {
    const h = await launchWriting('experiment', 2, false)
    try {
      await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: '<p>alpha</p><p>bravo</p>' }] })
      await h.page.evaluate(installPresentationProbe)
      await h.page.evaluate(interruption => {
        const pane = window.writingPanes[0] as FlowPane
        const doc = document.querySelector('iframe')!.contentDocument!
        const root = doc.querySelector('[data-scene-id]')!
        const block = root.children[0]
        const original = block.setAttribute.bind(block)
        root.children[1].setAttribute('title', 'pending')
        block.setAttribute = (name, value) => {
          if (interruption !== 'before') original(name, value)
          original('title', 'reentrant')
          block.firstChild!.textContent = 'changed'
          block.append(doc.createTextNode(' added'))
          if (interruption !== 'none') throw new Error('Synthetic interrupted field operation')
        }
        try { pane.presentation.spacing(block, 'after', 153) }
        catch (error) { if (!(error instanceof Error) || error.message !== 'Synthetic interrupted field operation') throw error }
        finally { block.setAttribute = original }
        pane.capture()
        for (const frame of document.querySelectorAll('iframe')) (frame.contentWindow as EditorWindow).flushPendingContentChange()
      }, interruption)
      const after = await snapshotWriting(h.page)
      expect(after.panes[0].scenes[0].html).toBe('<p title="reentrant">changed added</p><p title="pending">bravo</p>')
      expect(after.panes[1].scenes).toEqual(after.panes[0].scenes)
      expect(after.panes[1].deltas).toEqual(after.panes[0].deltas)
      expect(after.panes[0].undoGroups).toEqual([[0]])
      await h.page.evaluate(() => window.writingPanes[0].undo())
      expect((await snapshotWriting(h.page)).panes[0].scenes[0].html).toBe('<p>alpha</p><p>bravo</p>')
    } finally { await h.close() }
  })
}

test('page flow native generic fields separate loose inline runs without expanding authored paint', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron' || process.env.NOVALIST_WRITING_USER_CSS_PROBE !== '1', 'User-origin CSS geometry requires the explicitly gated Electron preload.')
  const h = await launchWriting('experiment', 1, false)
  try {
    await h.seed({ wordCount: 5, scenes: [{ id: 'owner', html }] })
    const result = await h.page.evaluate(() => {
      const bridge = window.writingUserCss
      if (typeof bridge?.flow !== 'function') return { available: false }
      const pane = window.writingPanes[0] as FlowPane
      const doc = document.querySelector('iframe')!.contentDocument!
      const root = doc.querySelector('[data-scene-id]')!
      const block = root.children[1]
      const raw = root.childNodes[2]
      const range = doc.createRange()
      range.setStart(raw, 0); range.setEnd(root.childNodes[3].firstChild!, 6)
      const measure = () => ({ block: block.getBoundingClientRect().toJSON(), raw: range.getBoundingClientRect().toJSON(), margin: doc.defaultView!.getComputedStyle(block).marginBottom })
      const before = measure()
      const owner = bridge.flow(0, true)
      pane.presentation.spacing(block, 'after', 153)
      const after = measure()
      bridge.flow(0, false)
      const disabled = measure()
      pane.presentation.spacing(block, 'after', null)
      return { available: true, before, after, disabled, owner, serialized: pane.serialize()[0].html }
    })
    await writeFile(info.outputPath('page-flow-generic.json'), JSON.stringify({ provenance: writingProvenance(),
      workload: { route: 'experiment', panes: 1, scenes: 1, words: 5, pageView: false },
      ...result, serialized: result.serialized === html }, null, 2))
    expect(result.available).toBe(true)
    expect(result.after!.raw.top - result.before!.raw.top).toBe(136)
    expect(result.after!.block).toEqual(result.before!.block)
    expect(result.disabled).toEqual(result.before)
    expect(result.serialized).toBe(html)
  } finally { await h.close() }
})

for (const display of ['block', 'table-row']) {
  test(`page flow imported geometry: ${display} before an anonymous inline run`, async ({}, info) => {
    test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron' || process.env.NOVALIST_WRITING_USER_CSS_PROBE !== '1', 'User-origin CSS geometry requires the explicitly gated Electron preload.')
    const h = await launchWriting('experiment', 1, false)
    const imported = `<p>opening</p><p style="display:${display} !important;margin:1em 0 !important;padding:0.5em !important;background:rgb(240, 220, 200)">alpha</p>bravo <em>inline</em><p>charlie</p>`
    try {
      await h.seed({ wordCount: 5, scenes: [{ id: 'owner', html: imported }] })
      const result = await h.page.evaluate(() => {
        const bridge = window.writingUserCss
        const pane = window.writingPanes[0] as FlowPane
        const doc = document.querySelector('iframe')!.contentDocument!
        const root = doc.querySelector('[data-scene-id]')!
        const nodes = Array.from(root.childNodes)
        const block = root.children[1]
        const authored = root.innerHTML
        const raw = doc.createRange()
        raw.setStart(root.childNodes[2], 0); raw.setEnd(root.childNodes[3].firstChild!, 6)
        const caret = doc.createRange()
        caret.setStart(root.childNodes[2], 0); caret.collapse(true)
        doc.getSelection()!.setBaseAndExtent(root.childNodes[2], 0, root.childNodes[2], 0)
        const measure = () => ({ block: block.getBoundingClientRect().toJSON(), raw: raw.getBoundingClientRect().toJSON(), caret: caret.getBoundingClientRect().toJSON(),
          display: doc.defaultView!.getComputedStyle(block).display, margin: doc.defaultView!.getComputedStyle(block).marginBottom })
        const before = measure()
        bridge.flow(0, true)
        pane.presentation.spacing(block, 'after', 153)
        const after = measure()
        const serialized = pane.serialize()[0].html
        return { before, after, authored, serialized, connected: nodes.every((node, index) => node.isConnected && root.childNodes[index] === node),
          selection: { anchorIsRaw: doc.getSelection()!.anchorNode === root.childNodes[2], offset: doc.getSelection()!.anchorOffset } }
      })
      await h.page.screenshot({ path: info.outputPath('imported-geometry.png') })
      const { authored, serialized, ...geometry } = result
      await writeFile(info.outputPath('page-flow-imported.json'), JSON.stringify({ provenance: writingProvenance(),
        workload: { route: 'experiment', panes: 1, scenes: 1, words: 5, pageView: false, display },
        ...geometry, authoredExact: authored === imported, serializedExact: serialized === imported }, null, 2))
      expect(result.authored).toBe(imported)
      expect(result.serialized).toBe(imported)
      expect(result.connected).toBe(true)
      expect(result.selection).toEqual({ anchorIsRaw: true, offset: 0 })
      expect(result.after.margin).toBe('153px')
      expect(result.after.block).toEqual(result.before.block)
      test.fail(display === 'table-row', 'Rejected margin-only layout: imported table-internal boxes ignore both margin anchors before anonymous text.')
      expect(result.after.raw.top - result.before.raw.top).toBe(136)
      expect(result.after.caret.top - result.before.caret.top).toBe(136)
    } finally { await h.close() }
  })
}

test('page flow imported geometry: original paginator retains repeated table-row and raw-text content on multiple papers', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native baseline geometry comparison.')
  const h = await launchWriting('original', 1, false)
  const imported = Array.from({ length: 60 }, () => '<p style="display:table-row !important;margin:1em 0 !important;background:rgb(240, 220, 200)">alpha</p>bravo').join('')
  try {
    await h.seed({ wordCount: 120, scenes: [{ id: 'owner', html: imported }] })
    const result = await h.frames()[0].evaluate(imported => {
      const editor = window as unknown as EditorWindow & { getCleanContentHtml(): string }
      const root = document.getElementById('editor')!
      const sanitizedExact = root.innerHTML === imported
      const nodes = Array.from(root.childNodes)
      const range = document.createRange()
      const measure = (node: Node) => { range.selectNode(node); return range.getBoundingClientRect().toJSON() }
      const natural = nodes.slice(0, 6).map(measure)
      editor.setPageView(true)
      const papers = Array.from(root.querySelectorAll('.nv-page'))
      const pages = papers.map(paper => {
        const rect = paper.getBoundingClientRect()
        const style = getComputedStyle(paper)
        const top = rect.top + parseFloat(style.paddingTop)
        const bottom = rect.bottom - parseFloat(style.paddingBottom)
        const atoms = Array.from(paper.childNodes).map(node => ({ index: nodes.indexOf(node), type: node.nodeType, rect: measure(node) }))
        return { rect: rect.toJSON(), top, bottom, atoms }
      })
      return { sanitizedExact, cleanExact: editor.getCleanContentHtml() === imported,
        connected: nodes.every(node => node.isConnected && root.contains(node)),
        orderExact: papers.flatMap(paper => Array.from(paper.childNodes)).every((node, index) => node === nodes[index]),
        nodeCount: nodes.length, natural, pages }
    }, imported)
    await h.page.screenshot({ path: info.outputPath('original-imported-pages.png') })
    await writeFile(info.outputPath('page-flow-original-imported.json'), JSON.stringify({ provenance: writingProvenance(),
      workload: { route: 'original', appliedAdaptations: false, panes: 1, scenes: 1, words: 120, pageView: true, pairs: 60 }, result }, null, 2))
    expect(result.sanitizedExact).toBe(true)
    expect(result.cleanExact).toBe(true)
    expect(result.connected).toBe(true)
    expect(result.orderExact).toBe(true)
    expect(result.nodeCount).toBe(120)
    expect(result.pages.length).toBeGreaterThan(1)
    for (const page of result.pages) for (const atom of page.atoms) {
      expect(atom.rect.top).toBeGreaterThanOrEqual(page.top)
      expect(atom.rect.bottom).toBeLessThanOrEqual(page.bottom)
    }
  } finally { await h.close() }
})

test('page flow imported geometry: table-row boundaries reject both margin anchors while scene spacing moves all content', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron' || process.env.NOVALIST_WRITING_USER_CSS_PROBE !== '1', 'User-origin CSS geometry requires the explicitly gated Electron preload.')
  const h = await launchWriting('experiment', 1, false)
  const imported = Array.from({ length: 3 }, () => '<p style="display:table-row !important;margin:1em 0 !important;background:rgb(240, 220, 200)">alpha</p>bravo').join('')
  try {
    await h.seed({ wordCount: 6, scenes: [{ id: 'owner', html: imported }] })
    const result = await h.page.evaluate(() => {
      const bridge = window.writingUserCss
      const pane = window.writingPanes[0] as FlowPane
      const doc = document.querySelector('iframe')!.contentDocument!
      const root = doc.querySelector('[data-scene-id]')!
      const nodes = Array.from(root.childNodes)
      const range = doc.createRange()
      const measure = () => nodes.map(node => { range.selectNode(node); return range.getBoundingClientRect().toJSON() })
      const before = measure()
      bridge.flow(0, true)
      pane.presentation.spacing(root.children[0], 'after', 153)
      const afterBottom = measure()
      pane.presentation.spacing(root.children[0], 'after', null)
      pane.presentation.spacing(root.children[1], 'before', 153)
      const afterTop = measure()
      pane.presentation.spacing(root.children[1], 'before', null)
      pane.presentation.spacing(root, 'before', 136)
      const afterScene = measure()
      pane.presentation.spacing(root, 'before', null)
      const restored = measure()
      return { before, afterBottom, afterTop, afterScene, restored,
        connected: nodes.every((node, index) => node.isConnected && root.childNodes[index] === node) }
    })
    const serialized = await h.page.evaluate(() => window.writingPanes[0].serialize()[0].html)
    await writeFile(info.outputPath('page-flow-imported-anchors.json'), JSON.stringify({ provenance: writingProvenance(),
      workload: { route: 'experiment', panes: 1, scenes: 1, words: 6, pageView: false, pairs: 3 }, result, serializedExact: serialized === imported }, null, 2))
    expect(result.connected).toBe(true)
    expect(serialized).toBe(imported)
    expect(result.afterBottom).toEqual(result.before)
    expect(result.afterTop).toEqual(result.before)
    expect(result.restored).toEqual(result.before)
    for (const [index, rect] of result.afterScene.entries()) expect(rect.top - result.before[index].top).toBe(136)
  } finally { await h.close() }
})
