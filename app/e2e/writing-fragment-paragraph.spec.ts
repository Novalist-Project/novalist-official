import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'
import { writingDiagnosticEvidence } from './fixtures/writingDiagnosticEvidence.mts'

test.beforeEach(() => { test.skip(process.env.NOVALIST_WRITING_FRAGMENTS !== '1', 'Requires the explicit fragment adapter route') })

for (const { tag, display } of [{ tag: 'p', display: 'inline' }, { tag: 'span', display: 'block' }, { tag: 'p', display: 'none' }]) test(`canonical rendered flow: authored ${tag} display:${display} at raw Middle`, async ({}, info) => {
  const attributed = `<${tag} title="keep" style="display:${display}">after</${tag}>`
  const html = 'bravo' + attributed + '<em>tail</em>'
  const expected = display === 'block' ? 'br<div>avo</div>' + attributed + '<em>tail</em>' : 'br<div>avo' + attributed + '<em>tail</em></div>'
  const samples = []
  for (const mode of ['original', 'experiment'] as const) {
    const h = await launchWriting(mode, mode === 'original' ? 1 : 2, false)
    const errors: string[] = []
    h.page.on('pageerror', error => errors.push(error.message))
    try {
      await h.seed({ wordCount: 3, scenes: [{ id: 'raw', html }] })
      const pathsBefore = mode === 'experiment' ? await h.page.evaluate(() => window.writingPanes[0].inspect().deltas[0].filter(run => run.attributes?.block).map(run => JSON.parse(run.attributes!.block)).filter(path => path.length)) : []
      const observed = await h.frames()[0].evaluateHandle(({ mode, tag }) => {
        const editorRoot = document.getElementById('editor')!
        const root = mode === 'original' ? editorRoot : editorRoot.querySelector<HTMLElement>('[data-scene-id="raw"]')!
        const raw = root.firstChild!, authored = root.querySelector(tag)!
        const originalHtml = authored.outerHTML
        const nodes: Node[] = [root]
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL)
        while (walker.nextNode()) nodes.push(walker.currentNode)
        type Shape = { tag: string; identity: number; length: number; attributes: string[]; children: Shape[] }
        const shape = (node: Node): Shape => ({ tag: node.nodeName, identity: nodes.indexOf(node), length: node.nodeType === 3 ? node.textContent!.length : 0,
          attributes: node.nodeType === 1 ? (node as Element).getAttributeNames() : [], children: Array.from(node.childNodes, shape) })
        const point = () => {
          const selected = window.getSelection()!
          return { anchorIdentity: nodes.indexOf(selected.anchorNode!), anchorTag: selected.anchorNode?.nodeName, anchorOffset: selected.anchorOffset,
            focusIdentity: nodes.indexOf(selected.focusNode!), focusTag: selected.focusNode?.nodeName, focusOffset: selected.focusOffset }
        }
        let before: object | null = null, native: object | null = null
        document.addEventListener('beforeinput', () => { before = { ...point(), display: getComputedStyle(authored).display } }, { capture: true, once: true })
        document.addEventListener('input', () => { native = { ...point(), tree: shape(mode === 'original' ? root : editorRoot) } }, { capture: true, once: true })
        editorRoot.focus({ preventScroll: true })
        window.getSelection()!.setBaseAndExtent(raw, 2, raw, 2)
        return () => {
          const texts = document.createTreeWalker(editorRoot, NodeFilter.SHOW_TEXT)
          const rectangles = []
          while (texts.nextNode()) {
            const range = document.createRange()
            range.selectNodeContents(texts.currentNode)
            rectangles.push({ identity: nodes.indexOf(texts.currentNode), length: texts.currentNode.textContent!.length, rects: Array.from(range.getClientRects(), rect => rect.toJSON()) })
          }
          const paragraph = root.querySelector('div')
          return { before, native, after: point(), html: root.innerHTML, rectangles, paragraphHeight: paragraph?.getBoundingClientRect().height ?? null,
            authoredRetained: authored.isConnected && authored.outerHTML === originalHtml, display: getComputedStyle(authored).display }
        }
      }, { mode, tag })
      await h.page.keyboard.press('Enter')
      const result = await h.frames()[0].evaluate(read => read(), observed)
      const captureError = mode === 'experiment' ? await h.page.evaluate(() => {
        try { window.writingPanes[0].serialize(); return null }
        catch (error) { return error instanceof Error ? error.message : String(error) }
      }) : null
      let history = null
      if (mode === 'experiment' && !captureError) {
        const after = await h.page.evaluate(() => window.writingPanes.map(pane => ({ scenes: pane.serialize(), groups: pane.inspect().undoGroups,
          paths: pane.inspect().deltas[0].filter(run => run.attributes?.block).map(run => JSON.parse(run.attributes!.block)).filter(path => path.length) })))
        await h.page.keyboard.press('Control+z')
        const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
        await h.page.keyboard.press('Control+y')
        history = { after, undone, redone: await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize())) }
      }
      samples.push({ mode, result, errors, captureError, pathsBefore, history })
      await observed.dispose()
    } finally { await h.close() }
  }
  await writeFile(info.outputPath('fragment-canonical-display-conflict.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { tag, display, panes: 2, controlPanes: 1, scenes: 1, words: 3 }, samples }), null, 2))
  expect(samples.every(sample => sample.result.authoredRetained)).toBe(true)
  expect(samples[1].captureError).toBeNull()
  const changed = samples[1]
  expect(changed.history!.after.map(pane => pane.scenes[0].html)).toEqual([expected, expected])
  expect(changed.history!.after[0].groups).toEqual([[0]])
  expect(changed.history!.undone.map(pane => pane[0].html)).toEqual([html, html])
  expect(changed.history!.redone.map(pane => pane[0].html)).toEqual([expected, expected])
  expect(changed.result.after).toEqual(samples[0].result.after)
  expect(changed.result.after).toMatchObject({ anchorIdentity: 1, focusIdentity: 1, anchorOffset: 0, focusOffset: 0 })
  expect(changed.result.paragraphHeight).toBeGreaterThan(0)
  const suffix = changed.result.rectangles.find(item => item.identity === 1)!.rects[0]
  const authored = changed.result.rectangles.find(item => item.identity === 3)!.rects
  const tail = changed.result.rectangles.find(item => item.identity === 5)!.rects[0]
  if (display === 'block') {
    expect(authored[0].top).toBeGreaterThanOrEqual(suffix.bottom)
    expect(tail.top).toBeGreaterThanOrEqual(authored[0].bottom)
  } else {
    expect(Math.min(suffix.bottom, tail.bottom)).toBeGreaterThan(Math.max(suffix.top, tail.top))
    if (display === 'none') expect(authored).toEqual([])
    else expect(Math.min(suffix.bottom, authored[0].bottom)).toBeGreaterThan(Math.max(suffix.top, authored[0].top))
  }
  for (const prior of changed.pathsBefore) for (const pane of changed.history!.after) {
    const path = pane.paths.find(path => path.at(-1).id === prior.at(-1).id)
    expect(path?.slice(1)).toEqual(prior)
    expect(path?.[0].tag).toBe('div')
  }
})

const placements = ['before', 'at', 'after'] as const
const cases: { kind: 'start' | 'middle' | 'end'; placement: typeof placements[number] | null; mode: string; scope: string | null; rich?: boolean }[] = [
  ...(['end', 'middle'] as const).map(kind => ({ kind, placement: null, mode: 'page', scope: null })),
  ...placements.flatMap(placement => (['start', 'middle', 'end'] as const).map(kind => ({ kind, placement, mode: 'page', scope: null }))),
  ...['scene', 'chapter', 'manuscript'].flatMap(scope => ['normal', 'page', 'combined'].map(mode => ({ kind: 'middle' as const, placement: null, scope, mode }))),
  ...(['start', 'middle', 'end'] as const).map(kind => ({ kind, placement: null, scope: 'manuscript', mode: 'page', rich: true }))
]
for (const { kind, placement, mode, scope, rich } of cases) test(`canonical raw paragraph: ${rich ? 'mixed-authored' : scope ? scope + '-' + mode : placement ?? 'first'} ${kind} retains sibling paths and useful papers`, async ({}, info) => {
  let leadCount = 0
  if (placement) {
    const calibration = await launchWriting('experiment', 1, false)
    try {
      await calibration.seed({ wordCount: 40, scenes: [{ id: 'measure', html: '<p>lead</p>'.repeat(40) }] })
      leadCount = await calibration.frames()[0].evaluate(async () => {
        await document.fonts.ready
        ;(window as unknown as EditorWindow).setPageView(true)
        return document.querySelector('.nv-page')!.querySelectorAll('p').length
      }) + placements.indexOf(placement) - 1
    } finally { await calibration.close() }
  }
  const h = await launchWriting('experiment', 2, false)
  const writer = rich ? 1 : 0
  const tailCount = !placement && kind === 'end' ? 1 : 40
  const tail = rich ? '<p title="keep" style="margin:1em 0 !important">after</p>trailing<strong title="last">inline</strong><div data-author="container"><p>nested</p></div><ul><li>list</li></ul><table><tbody><tr><td>cell</td></tr></tbody></table><figure><figcaption>caption</figcaption></figure>'
    : '<p title="keep" data-author="original">after</p>'.repeat(tailCount)
  const lead = '<p>lead</p>'.repeat(leadCount)
  const inline = rich ? '<em title="inline">tail</em><span class="nv-comment" data-comment-id="retained">note</span><img width="12" height="12" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'
    : placement || kind === 'middle' ? '<em title="inline">tail</em>' : ''
  const html = lead + 'bravo' + inline + tail
  const expected = lead + (kind === 'start' ? '<div><br></div>bravo' + inline : kind === 'end' ? 'bravo<div>' + (inline || '<br>') + '</div>' : 'br<div>avo' + inline + '</div>') + tail
  const workload = { kind, placement, leadCount, scope, mode, rich: !!rich, writer, panes: 2, scenes: scope ? 3 : 2, words: rich ? 10 : leadCount + tailCount + 2 + (inline ? 1 : 0) + (scope ? 1 : 0) }
  try {
    await h.seed({ wordCount: workload.words, scenes: [{ id: 'raw', html }, { id: 'neighbor', html: '<p>neighbor</p>' }, ...(scope ? [{ id: 'outside', html: '<p>outside</p>' }] : [])] })
    const beforePaths = await h.page.evaluate(() => window.writingPanes[0].inspect().deltas[0].filter(run => run.attributes?.block).map(run => JSON.parse(run.attributes!.block)).filter(path => path.length))
    await h.page.evaluate(({ scope, mode }) => {
      for (const [index, pane] of window.writingPanes.entries()) {
        pane.scope(scope === 'scene' ? [0] : scope === 'chapter' ? [0, 1] : [0, 1, 2])
        const editor = document.querySelectorAll('iframe')[index].contentWindow as unknown as EditorWindow
        editor.setPageView(mode !== 'normal')
        editor.setTypewriterScroll(mode === 'combined', 'middle')
      }
    }, { scope, mode })
    const observed = await h.frames()[writer].evaluateHandle(kind => {
      const root = document.getElementById('editor')!
      const raw = Array.from(root.querySelectorAll('[data-scene-id="raw"]')).flatMap(fragment => Array.from(fragment.childNodes)).find(node => node.nodeType === 3 && node.textContent === 'bravo')!
      const fragment = raw.parentElement!
      const inlineText = raw.nextSibling?.nodeName === 'EM' ? raw.nextSibling.firstChild : null
      const inlineNodes = new Set<Node>()
      for (let node = raw.nextSibling; node && node.nodeName !== 'P'; node = node.nextSibling) inlineNodes.add(node)
      const placement = { page: Array.from(root.querySelectorAll('.nv-page')).indexOf(fragment.closest('.nv-page')!), atom: Array.from(fragment.childNodes).indexOf(raw as ChildNode) }
      const original = Array.from(root.querySelectorAll('[data-scene-id="raw"]')).flatMap(fragment => Array.from(fragment.children))
      const attributes = original.map(node => node.outerHTML)
      let native: object | null = null
      document.addEventListener('input', () => {
        const selection = window.getSelection()!
        native = { sameSuffix: selection.anchorNode === raw && selection.focusNode === raw, sameInline: selection.anchorNode === inlineText && selection.focusNode === inlineText,
          anchorTag: selection.anchorNode?.nodeName, anchorOffset: selection.anchorOffset, focusTag: selection.focusNode?.nodeName, focusOffset: selection.focusOffset,
          shapes: Array.from(fragment.parentElement!.children, child => ({ tag: child.tagName, children: Array.from(child.childNodes, node => ({ tag: node.nodeName, originalParagraph: original.indexOf(node as Element) })) })) }
      }, { once: true, capture: true })
      root.focus({ preventScroll: true })
      const offset = kind === 'start' ? 0 : kind === 'end' ? 5 : 2
      window.getSelection()!.setBaseAndExtent(raw, offset, raw, offset)
      return () => {
        const paragraph = root.querySelector<HTMLElement>('[data-scene-id="raw"] > div')
        const selected = window.getSelection()!
        return { native, placement, paragraphHeight: paragraph?.getBoundingClientRect().height ?? 0,
          endpoint: { sameParagraph: selected.anchorNode === paragraph && selected.focusNode === paragraph, sameSuffix: selected.anchorNode === raw && selected.focusNode === raw, sameInline: selected.anchorNode === inlineText && selected.focusNode === inlineText, anchorOffset: selected.anchorOffset, focusOffset: selected.focusOffset },
          retained: original.every((node, index) => node.isConnected && node.outerHTML === attributes[index]
            && (kind !== 'start' && inlineNodes.has(node) ? node.parentElement === paragraph : node.parentElement!.hasAttribute('data-writing-fragment'))) }
      }
    }, kind)
    await h.page.keyboard.press('Enter')
    const observedResult = await h.frames()[writer].evaluate(read => read(), observed)
    const after = await h.page.evaluate(() => window.writingPanes.map(pane => {
      try { return { error: null, scenes: pane.serialize(), groups: pane.inspect().undoGroups,
        paths: pane.inspect().deltas[0].filter(run => run.attributes?.block).map(run => JSON.parse(run.attributes!.block)).filter(path => path.length) } }
      catch (error) { return { error: error instanceof Error ? error.message : String(error), scenes: [], groups: [], paths: [] } }
    }))
    if (after.some(pane => pane.error)) {
      await writeFile(info.outputPath('fragment-canonical-first.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload, result: { observedResult, after } }), null, 2))
      expect(after.map(pane => pane.error)).toEqual([null, null])
    }
    const geometry = await h.frames()[writer].evaluate(() => {
      (window as unknown as EditorWindow).repaginatePageView()
      const root = document.getElementById('editor')!
      return Array.from(root.querySelectorAll<HTMLElement>('.nv-page'), page => {
        const top = page.getBoundingClientRect().top + parseFloat(getComputedStyle(page).paddingTop)
        const bottom = top + 48 * parseFloat(getComputedStyle(root).fontSize)
        const range = document.createRange()
        const atoms = Array.from(page.querySelectorAll(':scope > [data-writing-fragment]')).flatMap(fragment => Array.from(fragment.childNodes))
        return { count: atoms.length, fit: atoms.every(node => { range.selectNode(node); return Array.from(range.getClientRects()).every(rect => rect.top >= top - 0.1 && rect.bottom <= bottom + 0.1) }) }
      })
    })
    await h.page.keyboard.press('Control+z')
    const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await h.page.keyboard.press('Control+y')
    const redone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    const toggled = await h.page.evaluate(({ mode, scope }) => {
      for (const [index, pane] of window.writingPanes.entries()) {
        const editor = document.querySelectorAll('iframe')[index].contentWindow as unknown as EditorWindow
        editor.setPageView(mode === 'normal')
        pane.scope([])
        pane.scope(scope === 'scene' ? [0] : scope === 'chapter' ? [0, 1] : [0, 1, 2])
        editor.setPageView(mode !== 'normal')
      }
      return window.writingPanes.map(pane => ({ scenes: pane.serialize(), groups: pane.inspect().undoGroups }))
    }, { mode, scope })
    await writeFile(info.outputPath('fragment-canonical-first.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload, result: { observedResult, geometry, after, undone, redone, toggled } }), null, 2))
    expect(after.map(pane => pane.scenes[0].html)).toEqual([expected, expected])
    const oldIds = new Set(beforePaths.map(path => path.at(-1).id))
    expect(after.every(pane => JSON.stringify(pane.paths.filter(path => oldIds.has(path.at(-1).id))) === JSON.stringify(beforePaths))).toBe(true)
    expect(observedResult.retained).toBe(true)
    expect(observedResult.paragraphHeight).toBeGreaterThan(0)
    expect(observedResult.endpoint).toEqual({ sameParagraph: kind === 'end' && !inline, sameSuffix: kind !== 'end', sameInline: kind === 'end' && !!inline, anchorOffset: 0, focusOffset: 0 })
    if (kind === 'start') expect(observedResult.native).toMatchObject({ sameSuffix: true, anchorOffset: 0, focusOffset: 0 })
    expect(geometry.every(page => page.fit)).toBe(true)
    if (placement) {
      expect(geometry.length).toBeGreaterThan(1)
      expect(observedResult.placement.page).toBe(placement === 'before' ? 0 : 1)
      if (placement !== 'before') expect(observedResult.placement.atom).toBe(placement === 'at' ? 0 : 1)
    }
    expect(after[0].groups).toEqual([[0]])
    expect(undone.every(pane => pane[0].html === html && pane[1].html === '<p>neighbor</p>')).toBe(true)
    expect(redone.every(pane => pane[0].html === expected && pane[1].html === '<p>neighbor</p>')).toBe(true)
    expect(toggled).toEqual(after.map(pane => ({ scenes: pane.scenes, groups: pane.groups })))
    await observed.dispose()
  } finally { await h.close() }
})

for (const mode of ['original', 'experiment'] as const) test(`canonical raw End falsifier ${mode}: lifting an attributed following paragraph retains a visible new line`, async ({}, info) => {
  const h = await launchWriting(mode, 1, false)
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'raw', html: 'bravo<p title="keep" data-author="original">after</p>' }] })
    const observed = await h.frames()[0].evaluateHandle(mode => {
      if (mode === 'experiment') (window as unknown as EditorWindow).setPageView(true)
      const editorRoot = document.getElementById('editor')!
      const root = mode === 'original' ? editorRoot : editorRoot.querySelector<HTMLElement>('[data-writing-fragment]')!
      const raw = root.firstChild!, following = root.lastChild as HTMLElement
      const text = following.firstChild!
      const attributes = following.outerHTML
      let result: object | null = null
      let intent = false
      const point = (node: Node | null, offset: number) => ({ node: node === raw ? 'raw' : node === text ? 'following-text' : node === following ? 'following-p' : node?.nodeName ?? null, offset })
      editorRoot.focus({ preventScroll: true })
      window.getSelection()!.setBaseAndExtent(raw, 5, raw, 5)
      document.addEventListener('beforeinput', event => {
        const selection = window.getSelection()!
        intent = (event as InputEvent).inputType === 'insertParagraph' && selection.isCollapsed && selection.anchorNode === raw && selection.anchorOffset === 5
          && root.childNodes.length === 2 && root.firstChild === raw && root.lastChild === following
      }, { capture: true, once: true })
      document.addEventListener('input', event => {
        if ((event as InputEvent).inputType !== 'insertParagraph') return
        const added = Array.from(root.childNodes).filter(node => node !== raw && node !== following)
        const wrapper = added[0] as HTMLElement | undefined
        const selection = window.getSelection()!
        const anchor = selection.anchorNode!, anchorOffset = selection.anchorOffset
        const focus = selection.focusNode!, focusOffset = selection.focusOffset
        type Shape = { tag: string; identity: string; length: number; attributes: string[]; children: Shape[] }
        const shape = (node: Node): Shape => ({ tag: node.nodeName, identity: node === raw ? 'raw' : node === following ? 'following-p' : node === text ? 'following-text' : node === root ? 'root' : 'other',
          length: node.nodeType === 3 ? node.textContent!.length : 0, attributes: node.nodeType === 1 ? (node as Element).getAttributeNames() : [], children: Array.from(node.childNodes, shape) })
        const native = { html: root.innerHTML, intent, tree: shape(mode === 'original' ? root : root.parentElement!), anchor: point(anchor, anchorOffset), focus: point(focus, focusOffset) }
        const proven = intent && added.length === 1 && wrapper?.tagName === 'DIV' && !wrapper.attributes.length && wrapper.childNodes.length === 1 && wrapper.firstChild === following
          && root.childNodes.length === 2 && root.firstChild === raw && raw.textContent === 'bravo' && following.outerHTML === attributes
        if (!proven) { result = { native, proven }; return }
        root.insertBefore(following, wrapper.nextSibling)
        selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
        result = { native, proven, canonical: { html: root.innerHTML, anchor: point(selection.anchorNode, selection.anchorOffset), focus: point(selection.focusNode, selection.focusOffset),
          paragraphHeight: wrapper.getBoundingClientRect().height, children: wrapper.childNodes.length, originalFollowing: following.isConnected && following.outerHTML === attributes } }
      }, { capture: true, once: true })
      return () => result
    }, mode)
    await h.page.keyboard.press('Enter')
    const result = await h.frames()[0].evaluate(read => read(), observed) as { proven: boolean; canonical?: { html: string; paragraphHeight: number; originalFollowing: boolean } }
    await writeFile(info.outputPath('fragment-canonical-end-falsifier.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { engineRoute: mode, panes: 1, scenes: 1, words: 2 }, result }), null, 2))
    expect(result.proven).toBe(true)
    expect(result.canonical!.html).toBe('bravo<div></div><p title="keep" data-author="original">after</p>')
    expect(result.canonical!.originalFollowing).toBe(true)
    expect(result.canonical!.paragraphHeight).toBeGreaterThan(0)
    await observed.dispose()
  } finally { await h.close() }
})
