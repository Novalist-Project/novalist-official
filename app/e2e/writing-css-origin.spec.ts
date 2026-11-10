import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'
import { writingDiagnosticEvidence } from './fixtures/writingDiagnosticEvidence.mts'

declare global {
  interface Window {
    writingUserCss: {
      insert(pane: number, marginBottom: number): void
      remove(pane: number): void
      fixed(pane: number, enabled: boolean, marginBottom: number): { owner: number; installations: number }
    }
  }
}

test('CSS origin native platform proof: fixed sheet gate owns one installation per document', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Electron user-origin stylesheet capability only.')
  test.skip(process.env.NOVALIST_WRITING_USER_CSS_PROBE !== '1', 'Requires the explicitly gated fixture preload.')
  const h = await launchWriting('experiment', 2, false)
  const html = '<p style="margin:1em 0 !important;padding:0.5em !important">alpha</p>bravo<p>charlie</p>'
  const book = { wordCount: 3, scenes: [{ id: 'css-owner', html }] }
  try {
    await h.seed(book)
    const result = await h.page.evaluate(() => {
      const roots = Array.from(document.querySelectorAll('iframe'), frame => frame.contentDocument!.querySelector<HTMLElement>('[data-scene-id]')!)
      const children = roots.map(root => Array.from(root.childNodes))
      const measure = () => roots.map((root, index) => {
        const doc = root.ownerDocument
        const range = doc.createRange()
        range.selectNode(children[index][1])
        return { html: root.innerHTML, raw: range.getBoundingClientRect().toJSON(), block: root.firstElementChild!.getBoundingClientRect().toJSON(),
          margin: doc.defaultView!.getComputedStyle(root.firstElementChild!).marginBottom,
          connected: children[index].every((node, position) => node.isConnected && root.childNodes[position] === node),
          gate: doc.body.hasAttribute('data-writing-css-spacing'), variable: doc.body.style.getPropertyValue('--writing-css-margin') }
      })
      const before = measure()
      const owners = [window.writingUserCss.fixed(0, true, 153), window.writingUserCss.fixed(1, true, 85)]
      const both = measure()
      const toggles = []
      for (let round = 0; round < 5; round++) {
        const firstOff = window.writingUserCss.fixed(0, false, 153)
        const off = measure()
        const firstOn = window.writingUserCss.fixed(0, true, 170 + round)
        const on = measure()
        toggles.push({ firstOff, off, firstOn, on })
      }
      window.writingUserCss.fixed(0, false, 0)
      const finalOwner = window.writingUserCss.fixed(1, false, 0)
      const disabled = measure()
      return { before, owners, both, toggles, finalOwner, disabled }
    })
    const serialized = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()[0].html))
    await h.seed(book)
    const recreated = await h.page.evaluate(() => [window.writingUserCss.fixed(0, true, 153), window.writingUserCss.fixed(1, true, 85)])
    await writeFile(info.outputPath('css-origin-fixed.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
      workload: { route: 'experiment', panes: 2, scenes: 1, words: 3, toggles: 5, recreations: 1, pageView: false }, result, serialized, recreated }), null, 2))
    expect(result.owners).toEqual([{ owner: 1, installations: 1 }, { owner: 2, installations: 2 }])
    expect(serialized).toEqual([html, html])
    const stages = [result.before, result.both, result.disabled, ...result.toggles.flatMap(sample => [sample.off, sample.on])]
    for (const stage of stages) for (const [index, pane] of stage.entries()) {
      expect(pane.html).toBe(html)
      expect(pane.connected).toBe(true)
      expect(pane.block).toEqual(result.before[index].block)
    }
    expect(result.both[0].raw.top - result.before[0].raw.top).toBe(136)
    expect(result.both[1].raw.top - result.before[1].raw.top).toBe(68)
    for (const [round, sample] of result.toggles.entries()) {
      expect(sample.firstOff).toEqual({ owner: 1, installations: 2 })
      expect(sample.firstOn).toEqual({ owner: 1, installations: 2 })
      expect(sample.off[0]).toEqual(result.before[0])
      expect(sample.off[1]).toEqual(result.both[1])
      expect(sample.on[1]).toEqual(result.both[1])
      expect(sample.on[0].raw.top - result.before[0].raw.top).toBe(153 + round)
      expect(sample.on[0].block).toEqual(result.before[0].block)
      expect(sample.on[0].html).toBe(html)
      expect(sample.on[0].connected).toBe(true)
    }
    expect(result.disabled).toEqual(result.before)
    expect(result.finalOwner).toEqual({ owner: 2, installations: 2 })
    expect(recreated).toEqual([{ owner: 3, installations: 3 }, { owner: 4, installations: 4 }])
  } finally { await h.close() }
})

test('CSS origin native platform proof: isolated user-important spacing and removal', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Electron user-origin stylesheet capability only.')
  test.skip(process.env.NOVALIST_WRITING_USER_CSS_PROBE !== '1', 'Requires the explicitly gated fixture preload.')
  const h = await launchWriting('experiment', 2, false)
  const html = '<p style="margin:1em 0 !important;padding:0.5em !important">alpha</p>bravo<p>charlie</p>'
  try {
    await h.seed({ wordCount: 3, scenes: [{ id: 'css-owner', html }] })
    const result = await h.page.evaluate(async () => {
      const roots = Array.from(document.querySelectorAll('iframe'), frame => frame.contentDocument!.querySelector<HTMLElement>('[data-scene-id]')!)
      const children = roots.map(root => Array.from(root.childNodes))
      const measure = () => roots.map((root, index) => {
        const doc = root.ownerDocument
        const range = doc.createRange()
        range.selectNode(children[index][1])
        const caret = doc.createRange()
        caret.setStart(children[index][1], 0)
        caret.collapse(true)
        const block = root.firstElementChild!
        return { html: root.innerHTML, raw: range.getBoundingClientRect().toJSON(), block: block.getBoundingClientRect().toJSON(),
          caret: caret.getBoundingClientRect().toJSON(), marginBottom: doc.defaultView!.getComputedStyle(block).marginBottom,
          connected: children[index].every((node, position) => node.isConnected && root.childNodes[position] === node) }
      })
      const before = measure()
      window.writingUserCss.insert(0, 153)
      const first = measure()
      window.writingUserCss.insert(1, 85)
      const both = measure()
      window.writingUserCss.remove(0)
      const removedFirst = measure()
      window.writingUserCss.remove(1)
      const removedBoth = measure()
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const removalNextFrame = measure()
      return { before, first, both, removedFirst, removedBoth, removalNextFrame }
    })
    const serialized = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()[0].html))
    await writeFile(info.outputPath('css-origin.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
      workload: { route: 'experiment', panes: 2, scenes: 1, words: 3, platform: 'Electron user-origin CSS', pageView: false }, result, serialized }), null, 2))
    for (const stage of Object.values(result)) for (const pane of stage) {
      expect(pane.html).toBe(html)
      expect(pane.connected).toBe(true)
    }
    expect(serialized).toEqual([html, html])
    expect(result.first[0].raw.top - result.before[0].raw.top).toBe(136)
    expect(result.first[0].block).toEqual(result.before[0].block)
    expect(result.first[0].caret.top - result.before[0].caret.top).toBe(136)
    expect(result.first[1]).toEqual(result.before[1])
    expect(result.both[0]).toEqual(result.first[0])
    expect(result.both[1].raw.top - result.before[1].raw.top).toBe(68)
    expect(result.both[1].block).toEqual(result.before[1].block)
    expect(result.removedFirst[1]).toEqual(result.both[1])
    test.fail(true, 'Observed Electron user-origin stylesheet removal leaves spacing active through the next animation frame.')
    expect(result.removalNextFrame).toEqual(result.before)
  } finally { await h.close() }
})

for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight']) {
  test(`CSS origin native platform proof: ${key}`, async ({}, info) => {
    test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Electron user-origin stylesheet capability only.')
    test.skip(process.env.NOVALIST_WRITING_USER_CSS_PROBE !== '1', 'Requires the explicitly gated fixture preload.')
    const h = await launchWriting('original', 1, false)
    const html = '<p style="margin:1em 0 !important;padding:0.5em !important">alpha</p><p>bravo</p>'
    try {
      await h.seed({ wordCount: 2, scenes: [{ id: 'css-owner', html }] })
      const samples = []
      for (const enabled of [false, true]) {
        await h.frames()[0].evaluate(html => { document.getElementById('editor')!.innerHTML = html }, html)
        await h.page.evaluate(enabled => { if (enabled) window.writingUserCss.insert(0, 153) }, enabled)
        await h.frames()[0].evaluate(key => {
          const root = document.getElementById('editor')!
          root.focus({ preventScroll: true })
          const backwards = key === 'Backspace' || key === 'ArrowLeft'
          const text = root.querySelectorAll('p')[backwards ? 1 : 0].firstChild!
          window.getSelection()!.setBaseAndExtent(text, backwards ? 0 : 5, text, backwards ? 0 : 5)
        }, key)
        await h.page.keyboard.press(key)
        samples.push(await h.frames()[0].evaluate(() => {
          const root = document.getElementById('editor')!
          const selection = window.getSelection()!
          const paragraphs = Array.from(root.querySelectorAll('p'))
          return { html: root.innerHTML, text: root.textContent, anchorParagraph: paragraphs.findIndex(p => p.contains(selection.anchorNode)),
            anchorOffset: selection.anchorOffset, focusParagraph: paragraphs.findIndex(p => p.contains(selection.focusNode)),
            focusOffset: selection.focusOffset, collapsed: selection.isCollapsed }
        }))
      }
      await writeFile(info.outputPath('css-origin-key.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
        workload: { route: 'original', panes: 1, scenes: 1, words: 2, appliedAdaptations: false }, key, samples }), null, 2))
      expect(samples[1]).toEqual(samples[0])
      expect(samples[0].text).toBe('alphabravo')
      expect(samples[0].anchorParagraph).toBe(key === 'ArrowRight' ? 1 : 0)
      expect(samples[0].anchorOffset).toBe(key === 'ArrowRight' ? 0 : 5)
    } finally { await h.close() }
  })
}
