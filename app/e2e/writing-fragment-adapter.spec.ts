import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'
import { writingDiagnosticEvidence } from './fixtures/writingDiagnosticEvidence.mts'

test.beforeEach(() => { test.skip(process.env.NOVALIST_WRITING_FRAGMENTS !== '1', 'Requires the explicit fragment adapter route') })

test('fragment comment diagnostic: paired element-backed cross-paragraph control', async ({}, info) => {
  const initial = process.env.NOVALIST_WRITING_FRAGMENTS
  const samples = []
  try {
    for (const fragments of ['0', '1']) {
      process.env.NOVALIST_WRITING_FRAGMENTS = fragments
      const h = await launchWriting('experiment', 2, false)
      try {
        await h.seed({ wordCount: 6, scenes: [{ id: 'rich', html: '<p>alpha <span class="nv-comment" data-comment-id="existing">bravo</span> charlie</p>'.repeat(2) }] })
        await h.frames()[0].evaluate(() => {
          const root = document.getElementById('editor')!
          const paragraphs = root.querySelectorAll('p')
          root.focus({ preventScroll: true })
          window.getSelection()!.setBaseAndExtent(paragraphs[0].firstChild!, 2, paragraphs[1].lastChild!, 3)
          window.parent.writingPanes[0].command('wrapSelectionAsComment')
        })
        const result = await h.page.evaluate(() => ({ output: window.writingPanes.map(pane => pane.serialize()),
          shapes: Array.from(document.querySelectorAll('iframe'), frame => {
            type Shape = { tag: string; length: number; comment: string | null; children: Shape[] }
            const shape = (node: Node): Shape => ({ tag: node.nodeName, length: node.nodeType === 3 ? node.textContent!.length : 0,
              comment: node.nodeType === 1 ? (node as Element).getAttribute('data-comment-id') : null, children: Array.from(node.childNodes, shape) })
            return shape(frame.contentDocument!.querySelector('[data-scene-id="rich"]')!)
          }) }))
        samples.push({ fragments, ...result })
      } finally { await h.close() }
    }
  } finally { process.env.NOVALIST_WRITING_FRAGMENTS = initial }
  await writeFile(info.outputPath('fragment-comment-control.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), samples }), null, 2))
  for (const sample of samples) expect(sample.output[0]).toEqual(sample.output[1])
})

for (const command of ['toggleBold', 'wrapSelectionAsComment'] as const) test(`fragment rich slices: same-scene cross-paper copy and ${command}`, async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  const image = '<img width="12" height="12" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'
  const paragraph = '<p>alpha <span class="nv-comment" data-comment-id="existing">bravo</span>' + image + ' charlie</p>'
  try {
    await h.seed({ wordCount: 121, scenes: [{ id: 'rich', html: paragraph.repeat(40) }, { id: 'neighbor', html: '<p>neighbor</p>' }] })
    const before = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    const copied = await h.frames()[0].evaluate(() => {
      (window as unknown as EditorWindow).setPageView(true)
      const root = document.getElementById('editor')!
      const paragraphs = Array.from(root.querySelectorAll('p'))
      const count = root.querySelector('.nv-page')!.querySelectorAll('p').length
      const left = paragraphs[count - 1], right = paragraphs[count]
      root.focus({ preventScroll: true })
      window.getSelection()!.setBaseAndExtent(left.firstChild!, 2, right.lastChild!, 3)
      const control = document.createElement('div')
      for (const paragraph of [left, right]) control.append(paragraph.cloneNode(true))
      const range = document.createRange()
      range.setStart(control.firstChild!.firstChild!, 2)
      range.setEnd(control.lastChild!.lastChild!, 3)
      const expected = document.createElement('div')
      expected.append(range.cloneContents())
      const transfer = new DataTransfer()
      root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }))
      return { html: transfer.getData('text/html'), text: transfer.getData('text/plain'), expected: { html: expected.innerHTML, text: range.toString() }, differentPages: left.closest('.nv-page') !== right.closest('.nv-page') }
    })
    await h.page.evaluate(command => window.writingPanes[0].command(command), command)
    const after = await h.page.evaluate(() => window.writingPanes.map(pane => ({ scenes: pane.serialize(), groups: pane.inspect().undoGroups })))
    await h.page.keyboard.press('Control+z')
    const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await h.page.keyboard.press('Control+y')
    const redone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await writeFile(info.outputPath('fragment-rich-slices.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { command, panes: 2, scenes: 2, words: 121 }, result: { copied, after, undone, redone } }), null, 2))
    expect(copied.differentPages).toBe(true)
    expect({ html: copied.html, text: copied.text }).toEqual(copied.expected)
    expect(after[0].scenes).toEqual(after[1].scenes)
    expect(after[0].groups).toEqual([[0]])
    expect(after[0].scenes[0].html).toContain(command === 'toggleBold' ? '<b>' : 'data-comment-id="comment-0"')
    for (const pane of after) {
      expect(pane.scenes[0].html.match(/<img /g)).toHaveLength(40)
      expect(pane.scenes[0].html.match(/data-comment-id="existing"/g)).toHaveLength(40)
      expect(pane.scenes[1]).toEqual(before[0][1])
    }
    expect(undone).toEqual(before)
    expect(redone).toEqual(after.map(pane => pane.scenes))
  } finally { await h.close() }
})

test('fragment native composition: overflowing text and its ancestors stay pinned until commit', async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  const html = '<p>alpha bravo</p>'.repeat(40)
  const inserted = '漢'.repeat(300)
  try {
    await h.seed({ wordCount: 81, scenes: [{ id: 'long', html }, { id: 'neighbor', html: '<p>neighbor</p>' }] })
    const frame = h.frames()[0]
    const pinned = await frame.evaluateHandle(() => {
      const editor = window as unknown as EditorWindow
      editor.setPageView(true)
      const root = document.getElementById('editor')!
      const page = root.querySelector<HTMLElement>('.nv-page')!
      const paragraphs = Array.from(page.querySelectorAll('p'))
      const node = paragraphs.at(-1)!.firstChild!
      const chain: Node[] = [node]
      while (chain.at(-1) !== root) chain.push(chain.at(-1)!.parentNode!)
      root.focus({ preventScroll: true })
      window.getSelection()!.setBaseAndExtent(node, 11, node, 11)
      return () => ({ boundary: paragraphs.length, sameAncestors: chain.every((child, index) => child.isConnected && (index === chain.length - 1 || child.parentNode === chain[index + 1])),
        sameText: window.getSelection()!.focusNode === node,
        overflowing: paragraphs.at(-1)!.getBoundingClientRect().bottom > page.getBoundingClientRect().top + parseFloat(getComputedStyle(page).paddingTop) + 48 * parseFloat(getComputedStyle(root).fontSize) })
    })
    const session = await h.page.context().newCDPSession(h.page)
    await session.send('Input.imeSetComposition', { text: inserted, selectionStart: inserted.length, selectionEnd: inserted.length })
    await frame.evaluate(() => {
      const editor = window as unknown as EditorWindow
      editor.setPageView(false)
      editor.setPageView(true)
      window.parent.writingPanes[0].scope([1])
    })
    await h.page.waitForTimeout(180)
    const during = await frame.evaluate(check => check(), pinned)
    const peerBefore = await h.page.evaluate(() => window.writingPanes[1].serialize()[0].html)
    await session.send('Input.insertText', { text: inserted })
    const expected = '<p>alpha bravo</p>'.repeat(during.boundary - 1) + '<p>alpha bravo' + inserted + '</p>' + '<p>alpha bravo</p>'.repeat(40 - during.boundary)
    await expect.poll(() => h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()[0].html))).toEqual([expected, expected])
    const after = await frame.evaluate(() => {
      const root = document.getElementById('editor')!
      const hidden = Array.from(root.querySelectorAll<HTMLElement>('[data-scene-id="long"]')).every(fragment => !fragment.getClientRects().length)
      window.parent.writingPanes[0].scope([0, 1])
      return { hidden, groups: window.parent.writingPanes[0].inspect().undoGroups, pages: root.querySelectorAll('.nv-page').length }
    })
    await h.page.keyboard.press('Control+z')
    const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await h.page.keyboard.press('Control+y')
    const redone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await writeFile(info.outputPath('fragment-composition-overflow.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { panes: 2, scenes: 2, words: 81 }, result: { during, peerBefore: { html: peerBefore }, after, undone, redone } }), null, 2))
    expect(during.sameAncestors && during.sameText && during.overflowing).toBe(true)
    expect(peerBefore).toBe(html)
    expect(after.hidden).toBe(true)
    expect(after.groups).toEqual([[0]])
    expect(undone.every(pane => pane[0].html === html && pane[1].html === '<p>neighbor</p>')).toBe(true)
    expect(redone.every(pane => pane[0].html === expected && pane[1].html === '<p>neighbor</p>')).toBe(true)
    await pinned.dispose()
    await session.detach()
  } finally { await h.close() }
})

for (const action of ['Backspace', 'Delete', 'replace']) test(`fragment native boundary edit: ${action} within one logical scene`, async ({}, info) => {
  const html = '<p>alpha bravo</p>'.repeat(40)
  const samples = []
  let boundary = 0
  for (const mode of ['experiment', 'original'] as const) {
    const h = await launchWriting(mode, mode === 'experiment' ? 2 : 1, false)
    const errors: string[] = []
    h.page.on('pageerror', error => errors.push(error.message))
    try {
      await h.seed({ wordCount: 81, scenes: [{ id: 'long', html }, ...(mode === 'experiment' ? [{ id: 'neighbor', html: '<p>neighbor</p>' }] : [])] })
      const frame = h.frames()[0]
      if (mode === 'experiment') boundary = await frame.evaluate(() => {
        (window as unknown as EditorWindow).setPageView(true)
        return document.querySelector('.nv-page')!.querySelectorAll('p').length
      })
      const endpoints = await frame.evaluate(({ boundary, action }) => {
        const root = document.getElementById('editor')!
        const paragraphs = Array.from(root.querySelectorAll('p'))
        const left = paragraphs[boundary - 1].firstChild!, right = paragraphs[boundary].firstChild!
        root.focus({ preventScroll: true })
        const selected = window.getSelection()!
        if (action === 'Backspace') selected.setBaseAndExtent(right, 0, right, 0)
        else if (action === 'Delete') selected.setBaseAndExtent(left, left.textContent!.length, left, left.textContent!.length)
        else selected.setBaseAndExtent(left, 2, right, 3)
        return { boundary, differentPages: left.parentElement!.closest('.nv-page') !== right.parentElement!.closest('.nv-page') }
      }, { boundary, action })
      if (action === 'replace') await h.page.keyboard.insertText('X')
      else await h.page.keyboard.press(action)
      const output = await h.page.evaluate(mode => {
        try {
          return { scenes: mode === 'experiment' ? window.writingPanes.map(pane => pane.serialize()) : [[{ html: (document.querySelector('iframe')!.contentWindow as unknown as EditorWindow).getContent() }]],
            groups: mode === 'experiment' ? window.writingPanes[0].inspect().undoGroups : [], error: null }
        } catch (error) { return { scenes: [], groups: [], error: error instanceof Error ? error.message : String(error) } }
      }, mode)
      let history = null
      if (mode === 'experiment' && !output.error) {
        await h.page.keyboard.press('Control+z')
        const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
        await h.page.keyboard.press('Control+y')
        history = { undone, redone: await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize())) }
      }
      samples.push({ mode, endpoints, output, history, errors })
    } finally { await h.close() }
  }
  await writeFile(info.outputPath('fragment-boundary-edit.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { action, words: 81, scenes: 2, panes: 2 }, samples }), null, 2))
  expect(samples[0].endpoints.differentPages).toBe(true)
  expect(samples[0].output.error).toBeNull()
  const expected = samples[1].output.scenes[0][0].html
  expect(samples[0].output.scenes.map(pane => pane[0].html)).toEqual([expected, expected])
  expect(samples[0].output.groups).toEqual([[0]])
  expect(samples[0].history!.undone.every(pane => pane[0].html === html && pane[1].html === '<p>neighbor</p>')).toBe(true)
  expect(samples[0].history!.redone.every(pane => pane[0].html === expected && pane[1].html === '<p>neighbor</p>')).toBe(true)
})

for (const offset of [0, 2]) test(`fragment adapter: raw Enter ${offset} synchronizes one logical undo`, async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'raw', html: 'bravo' }, { id: 'next', html: 'charlie' }] })
    await Promise.all(h.frames().map(frame => frame.evaluate(() => (window as unknown as EditorWindow).setPageView(true))))
    await h.page.evaluate(offset => window.writingPanes[0].select({ scene: 0, offset }, { scene: 0, offset }), offset)
    await h.page.keyboard.press('Enter')
    const after = await h.page.evaluate(() => window.writingPanes.map(pane => ({ output: pane.serialize(), undoGroups: pane.inspect().undoGroups })))
    await h.page.keyboard.press('Control+z')
    const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await h.page.keyboard.press('Control+y')
    const redone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await writeFile(info.outputPath('fragment-adapter-enter.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { panes: 2, scenes: 2, words: 2, offset }, result: { after, undone, redone } }), null, 2))
    const expected = offset ? 'br<div>avo</div>' : '<div><br></div>bravo'
    expect(after.map(pane => pane.output[0].html)).toEqual([expected, expected])
    expect(after[0].undoGroups).toEqual([[0]])
    expect(undone.map(pane => pane[0].html)).toEqual(['bravo', 'bravo'])
    expect(redone.map(pane => pane[0].html)).toEqual([expected, expected])
    expect(redone.every(pane => pane.length === 2 && pane[1].html === 'charlie')).toBe(true)
  } finally { await h.close() }
})

test('fragment adapter: actual paper flow retains row/raw nodes, endpoints and clean output', async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  try {
    const pair = '<p style="display:table-row !important;margin:1em 0 !important;background:rgb(240, 220, 200)">alpha</p>bravo'
    await h.seed({ wordCount: 122, scenes: [{ id: 'long', html: pair.repeat(60) }, { id: 'short', html: 'charlie delta' }] })
    const result = await h.frames()[0].evaluate(() => {
      const root = document.getElementById('editor')!
      const original = Array.from(root.querySelector('[data-scene-id="long"]')!.childNodes)
      const anchor = original[1], focus = original.at(-1)!
      const selected = window.getSelection()!
      selected.setBaseAndExtent(focus, 3, anchor, 2)
      const editor = window as unknown as EditorWindow
      editor.setPageView(true)
      const pages = Array.from(root.querySelectorAll<HTMLElement>(':scope > .nv-page'), page => {
        const box = page.getBoundingClientRect()
        const style = getComputedStyle(page)
        const top = box.top + parseFloat(style.paddingTop)
        const bottom = top + 48 * parseFloat(getComputedStyle(root).fontSize)
        const range = document.createRange()
        const atoms = Array.from(page.querySelectorAll(':scope > [data-writing-fragment]')).flatMap(fragment => Array.from(fragment.childNodes))
        return { budget: bottom - top, fit: atoms.every(atom => { range.selectNode(atom); const rect = range.getBoundingClientRect(); return rect.top >= top - 0.1 && rect.bottom <= bottom + 0.1 }), count: atoms.length }
      })
      const exact = () => selected.anchorNode === focus && selected.anchorOffset === 3 && selected.focusNode === anchor && selected.focusOffset === 2
      const pagedExact = exact()
      editor.setPageView(false)
      return { pages, pagedExact, continuousExact: exact(), sameNodes: original.every(node => node.isConnected), frames: window.parent.document.querySelectorAll('iframe').length }
    })
    const output = await h.page.evaluate(() => window.writingPanes.map(pane => ({ scenes: pane.serialize(), undoGroups: pane.inspect().undoGroups })))
    await writeFile(info.outputPath('fragment-adapter-flow.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { panes: 2, scenes: 2, words: 122 }, result: { geometry: result, output } }), null, 2))
    expect(result.pages.length).toBeGreaterThan(1)
    expect(result.pages.every(page => page.fit && page.budget > 0)).toBe(true)
    expect(result.pagedExact && result.continuousExact && result.sameNodes).toBe(true)
    expect(result.frames).toBe(2)
    expect(output.every(pane => pane.undoGroups.length === 0 && pane.scenes.length === 2 && pane.scenes[0].html === pair.repeat(60))).toBe(true)
  } finally { await h.close() }
})

for (const { offset, later } of [{ offset: 0, later: false }, { offset: 2, later: false }, { offset: 5, later: false }, { offset: 2, later: true }]) test(`fragment adapter: mixed raw Enter ${offset} across multiple page fragments matches native paragraph intent${later ? ' with later fragments' : ''}`, async ({}, info) => {
  const padding = '<p>lead paragraph</p>'.repeat(40)
  const html = (later ? '' : padding) + '<p>prefix</p>bravo<em>tail</em><p>after</p>' + (later ? padding : '')
  const samples = []
  for (const mode of ['original', 'experiment'] as const) {
    const h = await launchWriting(mode, mode === 'experiment' ? 2 : 1, false)
    const errors: string[] = []
    h.page.on('pageerror', error => errors.push(error.message))
    try {
      await h.seed({ wordCount: 85, scenes: [{ id: 'mixed', html }, ...(mode === 'experiment' ? [{ id: 'neighbor', html: '<p>neighbor</p>' }] : [])] })
      const frame = h.frames()[0]
      if (mode === 'experiment') await frame.evaluate(() => (window as unknown as EditorWindow).setPageView(true))
      const snapshot = await frame.evaluateHandle(offset => {
        const root = document.getElementById('editor')!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL)
        const nodes: Node[] = []
        while (walker.nextNode()) nodes.push(walker.currentNode)
        const target = nodes.find(node => node.nodeType === 3 && node.textContent === 'bravo')!
        const atoms = nodes.filter(node => node.parentNode === root || (node.parentElement?.hasAttribute('data-writing-fragment') && node.nodeName !== 'SECTION'))
        const transitions: { phase: string; anchor: number; anchorOffset: number; focus: number; focusOffset: number }[] = []
        const transition = (phase: string) => {
          const selected = window.getSelection()!
          transitions.push({ phase, anchor: nodes.indexOf(selected.anchorNode!), anchorOffset: selected.anchorOffset, focus: nodes.indexOf(selected.focusNode!), focusOffset: selected.focusOffset })
        }
        const proofing = window as unknown as Window & { applyGrammarHighlights(): void }
        const apply = proofing.applyGrammarHighlights
        proofing.applyGrammarHighlights = () => { transition('proofing-before'); apply(); transition('proofing-after') }
        for (const event of ['focus', 'selectionchange', 'keydown']) document.addEventListener(event, () => transition(event), { capture: true })
        root.focus({ preventScroll: true })
        transition('after-focus')
        window.getSelection()!.setBaseAndExtent(target, offset, target, offset)
        transition('after-selection-setup')
        type Shape = { tag: string; identity: number; length: number; attributes: string[]; children: Shape[] }
        const shape = (node: Node): Shape => ({ tag: node.nodeName, identity: nodes.indexOf(node), length: node.nodeType === 3 ? node.textContent!.length : 0,
          attributes: node.nodeType === 1 ? (node as Element).getAttributeNames() : [], children: Array.from(node.childNodes, shape) })
        let preCapture: Shape | null = null
        const beforeInput: { anchor: number; anchorOffset: number; focus: number; focusOffset: number; targets: { start: number; startOffset: number; end: number; endOffset: number }[] }[] = []
        root.addEventListener('beforeinput', event => {
          const selected = window.getSelection()!
          beforeInput.push({ anchor: nodes.indexOf(selected.anchorNode!), anchorOffset: selected.anchorOffset, focus: nodes.indexOf(selected.focusNode!), focusOffset: selected.focusOffset,
            targets: Array.from(event.getTargetRanges(), range => ({ start: nodes.indexOf(range.startContainer), startOffset: range.startOffset, end: nodes.indexOf(range.endContainer), endOffset: range.endOffset })) })
        }, { capture: true, once: true })
        root.addEventListener('input', () => { preCapture = shape(root) }, { capture: true, once: true })
        return () => ({ transitions, beforeInput, preCapture, tree: shape(root), retained: atoms.map(node => node.isConnected), pages: root.querySelectorAll(':scope > .nv-page').length,
          targetConnected: target.isConnected, anchorIdentity: nodes.indexOf(window.getSelection()!.anchorNode!), anchorOffset: window.getSelection()!.anchorOffset })
      }, offset)
      await h.page.keyboard.press('Enter')
      const structure = await frame.evaluate(snapshot => snapshot(), snapshot)
      const output = await h.page.evaluate(mode => {
        if (mode === 'original') {
          const editor = document.querySelector('iframe')!.contentWindow as unknown as EditorWindow
          return { html: editor.getContent(), error: null }
        }
        try { return { html: window.writingPanes[0].serialize()[0].html, error: null } }
        catch (error) { return { html: '', error: error instanceof Error ? error.message : String(error) } }
      }, mode)
      let history = null
      if (mode === 'experiment' && !output.error) {
        const after = await h.page.evaluate(() => window.writingPanes.map(pane => ({ scenes: pane.serialize(), undoGroups: pane.inspect().undoGroups })))
        await h.page.keyboard.press('Control+z')
        const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
        await h.page.keyboard.press('Control+y')
        const redone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
        history = { after, undone, redone }
      }
      samples.push({ mode, structure, output, history, errors })
      await snapshot.dispose()
    } finally { await h.close() }
  }
  await writeFile(info.outputPath('fragment-adapter-mixed-enter.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { scenes: 2, words: 85, offset }, samples }), null, 2))
  expect(samples[1].structure.pages).toBeGreaterThan(1)
  expect(samples[1].output.error).toBeNull()
  expect(samples[1].output.html).toBe(samples[0].output.html)
  expect(samples[1].structure.retained.every(Boolean)).toBe(true)
  const history = samples[1].history!
  const expected = samples[0].output.html
  expect(history.after.every(pane => pane.scenes[0].html === expected)).toBe(true)
  expect(history.after[0].undoGroups).toEqual([[0]])
  expect(history.undone.every(pane => pane[0].html === html && pane[1].html === '<p>neighbor</p>')).toBe(true)
  expect(history.redone.every(pane => pane[0].html === expected && pane[1].html === '<p>neighbor</p>')).toBe(true)
})

for (const backward of [false, true]) test(`fragment proofing: real wrapping preserves raw boundary side ${backward ? 'backward' : 'forward'}`, async ({}, info) => {
  const h = await launchWriting('experiment', 1, false)
  try {
    await h.seed({ wordCount: 4, scenes: [{ id: 'proof', html: '<p>prefix</p>bravo<em>tail</em><p>after</p>' }] })
    const result = await h.frames()[0].evaluate(backward => {
      const editor = window as unknown as EditorWindow & { buildGrammarPlainTextMap(): { textNodes: { node: Node; start: number }[] }; setGrammarIssues(json: string): void }
      editor.setSceneContext('proof')
      const scene = document.querySelector<HTMLElement>('[data-scene-id="proof"]')!
      const raw = scene.childNodes[1] as Text
      const tail = scene.querySelector('em')!.firstChild!
      const selection = window.getSelection()!
      document.getElementById('editor')!.focus({ preventScroll: true })
      if (backward) selection.setBaseAndExtent(tail, 2, raw, 0)
      else selection.setBaseAndExtent(raw, 0, tail, 2)
      const offset = editor.buildGrammarPlainTextMap().textNodes.find(item => item.node === raw)!.start
      editor.setGrammarIssues(JSON.stringify([{ offset, length: 5, type: 'grammar', message: 'Synthetic issue', replacements: [] }]))
      const expectedRaw = scene.querySelector('.grammar-issue')!.firstChild!
      const check = (expected: Node) => ({ rawSide: (backward ? selection.focusNode : selection.anchorNode) === expected,
        rawOffset: backward ? selection.focusOffset : selection.anchorOffset,
        tailIdentity: (backward ? selection.anchorNode : selection.focusNode) === tail,
        tailOffset: backward ? selection.anchorOffset : selection.focusOffset,
        owner: (selection.focusNode?.parentElement?.closest<HTMLElement>('[data-scene-id]')?.dataset.sceneId ?? null),
        connected: expected.isConnected && tail.isConnected })
      const wrapped = check(expectedRaw)
      const forcedFallback = raw !== expectedRaw && raw.data !== 'bravo'
      editor.setGrammarIssues('[]')
      const unwrapped = check(Array.from(scene.childNodes).find(node => node.nodeType === 3 && node.textContent === 'bravo')!)
      return { forcedFallback, wrapped, unwrapped }
    }, backward)
    await writeFile(info.outputPath('fragment-proofing-boundary.json'), JSON.stringify({ provenance: writingProvenance(), workload: { backward, panes: 1, scenes: 1, words: 4 }, result }, null, 2))
    expect(result.forcedFallback).toBe(true)
    for (const endpoint of [result.wrapped, result.unwrapped]) expect(endpoint).toEqual({ rawSide: true, rawOffset: 0, tailIdentity: true, tailOffset: 2, owner: 'proof', connected: true })
  } finally { await h.close() }
})

for (const boundary of ['same-scene', 'cross-scene']) for (const backward of [false, true]) test(`fragment native aligned drag: ${boundary} ${backward ? 'backward' : 'forward'} across paper`, async ({}, info) => {
  const samples = []
  let firstPageCount = 0
  for (const mode of ['original', 'experiment'] as const) {
    const h = await launchWriting(mode, 2, false)
    try {
      const paragraph = '<p>alpha bravo</p>'
      const split = boundary === 'cross-scene' ? firstPageCount : 40
      await h.seed({ wordCount: 96, scenes: mode === 'original' ? [{ id: 'control', html: paragraph.repeat(48) }]
        : [{ id: 'first', html: paragraph.repeat(split) }, { id: 'second', html: paragraph.repeat(48 - split) }] })
      for (const frame of h.frames()) await frame.evaluate(async () => {
        await document.fonts.ready
        const editor = window as unknown as EditorWindow
        editor.setPageView(true)
        editor.setWritingZoom(0.5)
      })
      const frame = h.frames()[0]
      const measured = await frame.evaluate(backward => {
        const root = document.getElementById('editor')!
        const paragraphs = Array.from(root.querySelectorAll('p'))
        const papers = Array.from(root.querySelectorAll<HTMLElement>(':scope > .nv-page'))
        const count = papers[0].querySelectorAll('p').length
        const points = [{ index: count - 1, offset: 2 }, { index: count, offset: 3 }].map(point => {
          const range = document.createRange()
          range.setStart(paragraphs[point.index].firstChild!, point.offset)
          range.collapse(true)
          const rect = range.getBoundingClientRect()
          return { ...point, x: rect.x, y: rect.y + rect.height / 2 }
        })
        return { count, points: backward ? points.reverse() : points, dpr: window.devicePixelRatio,
          papers: papers.map(paper => paper.getBoundingClientRect().toJSON()),
          paragraphs: paragraphs.map(paragraph => paragraph.getBoundingClientRect().toJSON()),
          fonts: document.fonts.status }
      }, backward)
      if (mode === 'original') firstPageCount = measured.count
      else {
        expect(measured).toEqual(samples[0].measured)
        expect(boundary === 'cross-scene' ? split === measured.count : split > measured.count).toBe(true)
      }
      const box = await h.page.locator('iframe').first().boundingBox()
      if (!box) throw new Error('Missing native fixture frame')
      const points = measured.points.map(point => ({ ...point, x: Math.round((point.x + box.x) * measured.dpr) / measured.dpr, y: Math.round((point.y + box.y) * measured.dpr) / measured.dpr }))
      const preconditions = await frame.evaluate(points => points.map(point => {
        const paragraphs = Array.from(document.querySelectorAll('#editor p'))
        const caret = document.caretPositionFromPoint(point.x, point.y)
        return { sameText: caret?.offsetNode === paragraphs[point.index].firstChild, offset: caret?.offset }
      }), points.map(point => ({ ...point, x: point.x - box.x, y: point.y - box.y })))
      await writeFile(info.outputPath(`fragment-aligned-${mode}-precondition.json`), JSON.stringify({ provenance: writingProvenance(), boundary, backward, measured, points, preconditions }, null, 2))
      expect(preconditions).toEqual(points.map(point => ({ sameText: true, offset: point.offset })))
      const originals = await frame.evaluateHandle(() => Array.from(document.querySelectorAll('#editor p'), paragraph => paragraph.firstChild as Node | null))
      const peerBox = await h.page.locator('iframe').nth(1).boundingBox()
      const peerPoint = await h.frames()[1].evaluate(() => {
        const range = document.createRange()
        range.setStart(document.querySelector('#editor p')!.firstChild!, 2)
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y + rect.height / 2 }
      })
      if (!peerBox) throw new Error('Missing peer fixture frame')
      await h.page.mouse.click(Math.round((peerPoint.x + peerBox.x) * measured.dpr) / measured.dpr, Math.round((peerPoint.y + peerBox.y) * measured.dpr) / measured.dpr)
      const [start, end] = points
      const steps = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y))
      await h.page.mouse.move(start.x, start.y)
      await h.page.mouse.down()
      for (let step = 1; step <= steps; step++) await h.page.mouse.move(Math.round((start.x + (end.x - start.x) * step / steps) * measured.dpr) / measured.dpr, Math.round((start.y + (end.y - start.y) * step / steps) * measured.dpr) / measured.dpr)
      await h.page.mouse.up()
      const snapshot = () => frame.evaluate(nodes => {
        const selection = window.getSelection()!
        const wrapper = document.getElementById('editor-wrapper')!
        const surface = document.querySelector<HTMLElement>('.writing-zoom-surface')!
        return { anchor: nodes.indexOf(selection.anchorNode), anchorOffset: selection.anchorOffset, focus: nodes.indexOf(selection.focusNode), focusOffset: selection.focusOffset,
          collapsed: selection.isCollapsed, connected: nodes.every(node => node!.isConnected), focused: document.activeElement === document.getElementById('editor'),
          wrapperScroll: [wrapper.scrollLeft, wrapper.scrollTop], surfaceScroll: [surface.scrollLeft, surface.scrollTop] }
      }, originals)
      const immediate = await snapshot()
      await h.page.waitForTimeout(130)
      const callbackWindow = await snapshot()
      samples.push({ mode, measured, points, preconditions, steps, immediate, callbackWindow })
      await writeFile(info.outputPath(`fragment-aligned-${mode}-result.json`), JSON.stringify({ provenance: writingProvenance(), boundary, backward, result: samples.at(-1) }, null, 2))
      expect(immediate).toMatchObject({ anchor: start.index, anchorOffset: start.offset, focus: end.index, focusOffset: end.offset, collapsed: false, connected: true, focused: true, wrapperScroll: [0, 0], surfaceScroll: [0, 0] })
      expect(callbackWindow).toEqual(immediate)
      await originals.dispose()
    } finally { await h.close() }
  }
})
