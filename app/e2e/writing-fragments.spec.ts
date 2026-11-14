import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { launchWriting } from './fixtures/writingHarness'
import { installFragmentProbe } from './fixtures/writingFragmentProbe'
import { installFragmentEnterProbe } from './fixtures/writingFragmentEnterProbe'
import { packFragmentGeometryProbe } from './fixtures/writingFragmentGeometryProbe'
import { installFragmentMouseProbe } from './fixtures/writingFragmentMouseProbe'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { writingProvenance } from './fixtures/writingProvenance'
import { writingDiagnosticEvidence } from './fixtures/writingDiagnosticEvidence.mts'

const fixtures = [
  { name: 'paragraph', html: '<p>alpha</p><p>bravo</p>' },
  { name: 'row-raw', html: '<p style="display:table-row !important;margin:1em 0 !important;background:rgb(240, 220, 200)">alpha</p>bravo' }
]

for (const fixture of fixtures) for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'EnterStart', 'EnterMiddle', 'replacement']) {
  test(`fragment native same-scene boundary: ${fixture.name} ${key}`, async ({}, info) => {
    test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native representation falsifier.')
    const samples = []
    for (const fragmented of [false, true]) {
      const h = await launchWriting('original', 1, false)
      try {
        await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: fixture.html }] })
        const frame = h.frames()[0]
        await frame.evaluate(installFragmentProbe, fragmented)
        await frame.evaluate(key => {
          const probe = window.writingFragmentProbe
          if (key === 'replacement') probe.select(0, 2, 1, 3)
          else if (key === 'EnterStart' || key === 'EnterMiddle') probe.select(1, key === 'EnterStart' ? 0 : 2)
          else if (['Backspace', 'ArrowLeft', 'Home'].includes(key)) probe.select(1, key === 'Home' ? 3 : 0)
          else probe.select(0, key === 'End' ? 2 : 5)
        }, key)
        const before = await frame.evaluate(() => window.writingFragmentProbe.snapshot())
        expect(before.html).toBe(fixture.html)
        expect(before.retained).toEqual([true, true])
        expect(before.unowned).toBe(0)
        expect(before.pages).toBe(2)
        if (key === 'replacement') await h.page.keyboard.insertText('X')
        else await h.page.keyboard.press(key.startsWith('Enter') ? 'Enter' : key)
        const first = await frame.evaluate(() => window.writingFragmentProbe.snapshot())
        samples.push({ fragmented, before, first })
      } finally { await h.close() }
    }
    await writeFile(info.outputPath('fragment-native.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
      workload: { route: 'original', appliedAdaptations: false, automaticPagination: false, panes: 1, scenes: 1, words: 2, fixture: fixture.name }, key, samples }), null, 2))
    const [control, fragment] = samples.map(sample => sample.first)
    expect(fragment.html).toBe(control.html)
    expect(fragment.text).toBe(control.text)
    expect(fragment.anchor).toEqual(control.anchor)
    expect(fragment.focus).toEqual(control.focus)
    expect(fragment.collapsed).toBe(control.collapsed)
    expect(fragment.retained).toEqual(control.retained)
    expect(fragment.unowned).toBe(0)
    expect(fragment.unknownSections).toBe(0)
  })
}

for (const offset of [0, 2]) {
  test(`fragment raw Enter normalization preserves paragraph intent: offset ${offset}`, async ({}, info) => {
    test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native representation falsifier.')
    const samples = []
    for (const fragmented of [null, true]) {
      const h = await launchWriting('original', 1, false)
      try {
        await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: fixtures[1].html }] })
        const frame = h.frames()[0]
        await frame.evaluate(installFragmentProbe, fragmented)
        if (fragmented) await frame.evaluate(installFragmentEnterProbe)
        await frame.evaluate(offset => window.writingFragmentProbe.select(1, offset), offset)
        const before = await frame.evaluate(() => window.writingFragmentProbe.snapshot())
        await h.page.keyboard.press('Enter')
        const first = await frame.evaluate(() => window.writingFragmentProbe.snapshot())
        const normalization = await frame.evaluate(() => window.writingFragmentEnter ?? null)
        await h.page.keyboard.press('Control+z')
        const undo = await frame.evaluate(() => window.writingFragmentProbe.snapshot())
        samples.push({ fragmented, before, first, normalization, undo })
      } finally { await h.close() }
    }
    await writeFile(info.outputPath('fragment-enter.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
      workload: { route: 'original', appliedAdaptations: false, automaticPagination: false, nativeUndoDiagnostic: true, panes: 1, scenes: 1, words: 2 }, offset, samples }), null, 2))
    const [control, fragment] = samples
    expect(fragment.normalization?.error).toBeNull()
    expect(fragment.normalization?.applied).toBe(1)
    expect(fragment.first.html).toBe(control.first.html)
    expect(fragment.first.anchor).toEqual(control.first.anchor)
    expect(fragment.first.focus).toEqual(control.first.focus)
    expect(fragment.first.retained).toEqual(control.first.retained)
    expect(fragment.first.unowned).toBe(0)
    expect(fragment.first.unknownSections).toBe(0)
  })
}

test('fragment native forward drag isolation: script-free paper geometry', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native representation falsifier.')
  const samples = []
  for (const layout of ['flex', 'block']) {
    const h = await launchWriting('original', 1, false)
    try {
      await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: fixtures[0].html }] })
      await h.frames()[0].evaluate(installFragmentProbe, false)
      await h.frames()[0].evaluate(() => (window as unknown as EditorWindow).setWritingZoom(0.5))
      await h.page.evaluate(() => {
        const frame = document.querySelector('iframe')!
        const source = frame.contentDocument!
        const clone = source.documentElement.cloneNode(true) as HTMLElement
        clone.querySelectorAll('script').forEach(script => script.remove())
        const base = source.createElement('base')
        base.href = source.URL
        clone.querySelector('head')!.prepend(base)
        frame.srcdoc = '<!doctype html>' + clone.outerHTML
      })
      await h.page.waitForFunction(() => {
        const doc = document.querySelector('iframe')!.contentDocument
        return doc?.URL === 'about:srcdoc' && doc.readyState === 'complete'
      })
      const frame = h.frames()[0]
      if (layout === 'block') await frame.evaluate(() => {
        const style = document.createElement('style')
        style.textContent = 'body.page-view #editor { display:block; } body.page-view #editor > .nv-page { margin-inline:auto; } body.page-view #editor > .nv-page + .nv-page { margin-top:calc(var(--nl-space-xl) * 2); }'
        document.head.appendChild(style)
      })
      await frame.evaluate(installFragmentMouseProbe)
      const geometry = await frame.evaluate(() => {
        document.getElementById('editor')!.focus({ preventScroll: true })
        const points = Array.from(document.querySelectorAll('#editor p'), (paragraph, index) => {
          const range = document.createRange()
          range.setStart(paragraph.firstChild!, index === 0 ? 2 : 3)
          range.collapse(true)
          const rect = range.getBoundingClientRect()
          return { x: rect.x, y: rect.y + rect.height / 2 }
        })
        return { points, paperRects: Array.from(document.querySelectorAll('.nv-page'), paper => paper.getBoundingClientRect().toJSON()),
          display: getComputedStyle(document.getElementById('editor')!).display,
          scripts: document.scripts.length, hasEngine: 'NovalistEditorState' in window }
      })
      expect(geometry.scripts).toBe(0)
      expect(geometry.hasEngine).toBe(false)
      const [start, end] = geometry.points
      await h.page.mouse.move(start.x, start.y)
      await h.page.mouse.down()
      const down = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
      await h.page.mouse.move(end.x, end.y, { steps: 10 })
      const moved = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
      await h.page.mouse.up()
      const result = await frame.evaluate(() => ({ first: window.writingFragmentMouse.snapshot(), events: window.writingFragmentMouse.events }))
      samples.push({ layout, geometry, down, moved, ...result })
      if (!result.first.collapsed) break
    } finally { await h.close() }
  }
  await writeFile(info.outputPath('fragment-mouse-isolation.json'), JSON.stringify({ provenance: writingProvenance(),
    workload: { route: 'original-to-script-free-srcdoc', appliedAdaptations: false, automaticPagination: false, zoom: 0.5, panes: 1, scenes: 1, words: 2 }, samples }, null, 2))
  const result = samples.at(-1)!
  expect(result.down).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 0, focusOffset: 2, collapsed: true })
  expect(result.first).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 1, focusOffset: 3, collapsed: false })
})

test('fragment native forward drag isolation: minimal unstyled contenteditable', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native representation falsifier.')
  const h = await launchWriting('original', 1, false)
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: fixtures[0].html }] })
    await h.page.evaluate(() => {
      document.querySelector('iframe')!.srcdoc = '<!doctype html><div id="editor-wrapper"><div id="editor" contenteditable="true"><p>alpha</p><p>bravo</p></div></div>'
    })
    await h.page.waitForFunction(() => {
      const doc = document.querySelector('iframe')!.contentDocument
      return doc?.URL === 'about:srcdoc' && doc.readyState === 'complete'
    })
    const frame = h.frames()[0]
    await frame.evaluate(installFragmentMouseProbe)
    const geometry = await frame.evaluate(() => {
      const root = document.getElementById('editor')!
      root.focus({ preventScroll: true })
      const points = Array.from(root.querySelectorAll('p'), (paragraph, index) => {
        const range = document.createRange()
        range.setStart(paragraph.firstChild!, index === 0 ? 2 : 3)
        range.collapse(true)
        const box = range.getBoundingClientRect()
        return { x: box.x, y: box.y + box.height / 2 }
      })
      return { points, transform: getComputedStyle(root).transform, stylesheets: document.styleSheets.length, scripts: document.scripts.length }
    })
    const [start, end] = geometry.points
    await h.page.mouse.move(start.x, start.y)
    await h.page.mouse.down()
    const down = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
    await h.page.mouse.move(end.x, end.y, { steps: Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2) })
    const moved = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
    await h.page.mouse.up()
    const result = await frame.evaluate(() => ({ first: window.writingFragmentMouse.snapshot(), events: window.writingFragmentMouse.events }))
    await writeFile(info.outputPath('fragment-mouse-minimal.json'), JSON.stringify({ provenance: writingProvenance(),
      workload: { route: 'minimal-unstyled-srcdoc', appliedAdaptations: false, panes: 1, scenes: 1, words: 2 }, geometry, down, moved, ...result }, null, 2))
    expect(geometry).toMatchObject({ transform: 'none', stylesheets: 0, scripts: 0 })
    expect(down).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 0, focusOffset: 2, collapsed: true })
    expect(result.first).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 1, focusOffset: 3, collapsed: false })
  } finally { await h.close() }
})

test('fragment geometry: raw scenes share one paper with separate flow lines', async ({}, info) => {
  const h = await launchWriting('original', 1, false)
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: 'alpha beta' }] })
    const result = await h.frames()[0].evaluate(() => {
      const root = document.getElementById('editor')!
      const nodes = [root.firstChild!, document.createTextNode('charlie delta')]
      const paper = document.createElement('div')
      paper.className = 'nv-page'
      document.body.classList.add('page-view')
      root.appendChild(paper)
      const fragments = nodes.map(node => {
        const fragment = document.createElement('section')
        fragment.style.margin = '0'
        fragment.style.padding = '0'
        paper.appendChild(fragment)
        fragment.appendChild(node)
        return fragment
      })
      const range = document.createRange()
      const rects = nodes.map(node => { range.selectNode(node); return range.getBoundingClientRect().toJSON() })
      const box = paper.getBoundingClientRect()
      const style = getComputedStyle(paper)
      const top = box.top + parseFloat(style.paddingTop), bottom = box.bottom - parseFloat(style.paddingBottom)
      return { pages: root.querySelectorAll('.nv-page').length, html: fragments.map(fragment => fragment.innerHTML),
        connected: nodes.every((node, index) => node.isConnected && fragments[index].firstChild === node),
        rects, top, bottom, budget: 48 * parseFloat(getComputedStyle(root).fontSize) }
    })
    await writeFile(info.outputPath('fragment-raw-scenes.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
      workload: { route: 'original', appliedAdaptations: false, automaticPagination: false, panes: 1, scenes: 2, words: 4 }, result }), null, 2))
    expect(result.pages).toBe(1)
    expect(result.html).toEqual(['alpha beta', 'charlie delta'])
    expect(result.connected).toBe(true)
    expect(result.rects[1].top).toBeGreaterThanOrEqual(result.rects[0].bottom)
    expect(result.bottom - result.top).toBeCloseTo(result.budget)
    for (const rect of result.rects) { expect(rect.top).toBeGreaterThanOrEqual(result.top); expect(rect.bottom).toBeLessThanOrEqual(result.bottom) }
  } finally { await h.close() }
})

test('fragment geometry: retained row-raw content packs within actual 48em flow', async ({}, info) => {
  const h = await launchWriting('original', 1, false)
  try {
    await h.seed({ wordCount: 120, scenes: [{ id: 'owner', html: fixtures[1].html.repeat(60) }] })
    const result = await h.frames()[0].evaluate(packFragmentGeometryProbe)
    await writeFile(info.outputPath('fragment-row-geometry.json'), JSON.stringify({ provenance: writingProvenance(),
      workload: { route: 'original', appliedAdaptations: false, automaticPagination: false, initialAllAtomMeasurement: true, panes: 1, scenes: 1, words: 120 }, result }, null, 2))
    expect(result.cleanExact && result.connected && result.orderExact).toBe(true)
    expect(result.nodeCount).toBe(120)
    expect(result.pages.length).toBeGreaterThan(1)
    for (const page of result.pages) {
      expect(page.contentHeight).toBeCloseTo(result.em * 48)
      for (const atom of page.atoms) {
        expect(atom.rect.top).toBeGreaterThanOrEqual(page.top)
        expect(atom.rect.bottom).toBeLessThanOrEqual(page.bottom)
        expect(atom.rect.left).toBeGreaterThanOrEqual(page.left)
        expect(atom.rect.right).toBeLessThanOrEqual(page.right)
      }
    }
  } finally { await h.close() }
})

for (const trajectory of ['coarse', 'dense']) for (const backward of [false, true]) {
  test(`fragment native mouse selection ${trajectory} preserves exact endpoints: backward ${backward}`, async ({}, info) => {
    test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native representation falsifier.')
    const samples = []
    for (const fragmented of [false, true]) {
      const h = await launchWriting('original', 1, false)
      try {
        await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: fixtures[0].html }] })
        const frame = h.frames()[0]
        await frame.evaluate(installFragmentProbe, fragmented)
        await frame.evaluate(() => (window as unknown as EditorWindow).setWritingZoom(0.5))
        await frame.evaluate(() => document.getElementById('editor')!.focus({ preventScroll: true }))
        if (trajectory === 'dense') await frame.evaluate(installFragmentMouseProbe)
        const points = await frame.evaluate(() => Array.from(document.querySelectorAll('#editor p'), (paragraph, index) => {
          const range = document.createRange()
          range.setStart(paragraph.firstChild!, index === 0 ? 2 : 3)
          range.collapse(true)
          const box = range.getBoundingClientRect()
          return { x: box.x, y: box.y + box.height / 2 }
        }))
        const [start, end] = backward ? points.reverse() : points
        await h.page.mouse.move(start.x, start.y)
        await h.page.mouse.down()
        const down = await frame.evaluate(() => window.writingFragmentProbe.snapshot())
        const steps = trajectory === 'dense' ? Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2) : 10
        await h.page.mouse.move(end.x, end.y, { steps })
        const moved = await frame.evaluate(() => window.writingFragmentProbe.snapshot())
        await h.page.mouse.up()
        samples.push({ fragmented, points, steps, down, moved, first: await frame.evaluate(() => window.writingFragmentProbe.snapshot()),
          events: await frame.evaluate(() => window.writingFragmentMouse?.events ?? null) })
      } finally { await h.close() }
    }
    await writeFile(info.outputPath('fragment-mouse.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
      workload: { route: 'original', appliedAdaptations: false, automaticPagination: false, zoom: 0.5, panes: 1, scenes: 1, words: 2 }, trajectory, backward, samples }), null, 2))
    expect(samples[0].first.anchor.offset).toBe(backward ? 3 : 2)
    expect(samples[0].first.focus.offset).toBe(backward ? 2 : 3)
    expect(samples[0].first.collapsed).toBe(false)
    expect(samples[1].first).toEqual(samples[0].first)
  })
}

for (const offset of [0, 2]) {
  test(`fragment raw Enter retains live rich paragraph and one logical undo: offset ${offset}`, async ({}, info) => {
    test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native representation falsifier.')
    const h = await launchWriting('original', 1, false)
    try {
      await h.seed({ wordCount: 1, scenes: [{ id: 'owner', html: 'bravo' }] })
      const frame = h.frames()[0]
      await frame.evaluate(installFragmentProbe, true)
      await frame.evaluate(installFragmentEnterProbe)
      const bundle = await build({ entryPoints: [resolve('e2e/fixtures/writingFragmentHistoryProbe.ts')], bundle: true, write: false, format: 'iife', platform: 'browser' })
      await frame.addScriptTag({ content: bundle.outputFiles[0].text })
      await frame.evaluate(offset => window.writingFragmentProbe.select(0, offset), offset)
      const before = await frame.evaluate(() => window.writingFragmentHistory.snapshot())
      await h.page.keyboard.press('Enter')
      const first = await frame.evaluate(() => window.writingFragmentHistory.snapshot())
      await h.page.keyboard.press('Control+z')
      const undo = await frame.evaluate(() => window.writingFragmentHistory.snapshot())
      await h.page.keyboard.press('Control+y')
      const redo = await frame.evaluate(() => window.writingFragmentHistory.snapshot())
      await writeFile(info.outputPath('fragment-history.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
        workload: { route: 'original', appliedAdaptations: false, automaticPagination: false, liveElementMarkup: true, panes: 1, scenes: 1, words: 1 },
        offset, result: { before, first, undo, redo } }), null, 2))
      const authored = offset === 0 ? '<div><br></div>bravo' : 'br<div>avo</div>'
      const rich = offset === 0 ? '\ufffc\nbravo\n' : 'br\navo\n'
      expect(first).toEqual({ html: authored, text: rich, undo: 1, redo: 0, publications: 1, normalizedBeforeCapture: true })
      expect(undo).toEqual({ ...before, redo: 1, publications: 1, normalizedBeforeCapture: true })
      expect(redo).toEqual(first)
    } finally { await h.close() }
  })
}
