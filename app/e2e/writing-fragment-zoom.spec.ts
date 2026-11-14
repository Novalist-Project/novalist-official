import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { installFragmentProbe } from './fixtures/writingFragmentProbe'
import { installFragmentMouseProbe } from './fixtures/writingFragmentMouseProbe'
import { cloneFragmentPaperWithoutEngine, installFragmentTransformCarrier, measureFragmentPaperText } from './fixtures/writingFragmentZoomProbe'
import { writingProvenance } from './fixtures/writingProvenance'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

test('fragment native zoom isolation: matched transform placement', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native transform-placement falsifier.')
  const samples = []
  for (const owner of ['editor', 'carrier'] as const) {
    const h = await launchWriting('original', 1, false)
    try {
      await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: '<p>alpha</p><p>bravo</p>' }] })
      await h.frames()[0].evaluate(installFragmentProbe, false)
      await h.frames()[0].evaluate(() => (window as unknown as EditorWindow).setWritingZoom(0.5))
      await h.page.evaluate(cloneFragmentPaperWithoutEngine)
      await h.page.waitForFunction(() => {
        const doc = document.querySelector('iframe')!.contentDocument
        return doc?.URL === 'about:srcdoc' && doc.readyState === 'complete'
      })
      const frame = h.frames()[0]
      const measured = await frame.evaluate(installFragmentTransformCarrier, owner)
      if (samples.length && JSON.stringify(measured.geometry) !== JSON.stringify(samples[0].geometry)) {
        await writeFile(info.outputPath('fragment-zoom-preconditions.json'), JSON.stringify({ provenance: writingProvenance(), samples: [samples[0], { owner, ...measured }] }, null, 2))
        expect(measured.geometry).toEqual(samples[0].geometry)
      }
      await frame.evaluate(installFragmentMouseProbe)
      await frame.evaluate(() => document.getElementById('editor')!.focus({ preventScroll: true }))
      const frameBox = await h.page.locator('iframe').boundingBox()
      if (!frameBox) throw new Error('Missing native fixture frame geometry')
      const points = measured.geometry.rects.map(({ caret }) => ({ x: frameBox.x + caret.x, y: frameBox.y + caret.y + caret.height / 2 }))
      const [start, end] = points
      await h.page.mouse.move(start.x, start.y)
      await h.page.mouse.down()
      const down = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
      const steps = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2)
      await h.page.mouse.move(end.x, end.y, { steps })
      const moved = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
      await h.page.mouse.up()
      const result = await frame.evaluate(() => ({ first: window.writingFragmentMouse.snapshot(), events: window.writingFragmentMouse.events }))
      samples.push({ owner, ...measured, points, steps, down, moved, ...result })
    } finally { await h.close() }
  }
  await writeFile(info.outputPath('fragment-zoom-placement.json'), JSON.stringify({ provenance: writingProvenance(),
    workload: { route: 'script-free-srcdoc', appliedAdaptations: false, zoom: 0.5, panes: 1, scenes: 1, words: 2 }, samples }, null, 2))
  const [host, carrier] = samples
  expect(host.geometry).toEqual(carrier.geometry)
  expect(host.points).toEqual([{ x: 603.6875, y: 56.75 }, { x: 609.03125, y: 556.75 }])
  expect(host.geometry).toMatchObject({ scripts: 0, hasEngine: false, viewport: { top: 0, left: 0 } })
  expect(host.first).toMatchObject({ anchor: 1, anchorOffset: 3, focus: 1, focusOffset: 3, collapsed: true })
  for (const sample of samples) expect(sample.down).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 0, focusOffset: 2, collapsed: true })
  expect(carrier.moved).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 1, focusOffset: 3, collapsed: false })
  expect(carrier.first).toEqual(carrier.moved)
})

test('fragment native zoom isolation: standalone same-line forward drag', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native same-line selection falsifier.')
  const h = await launchWriting('original', 1, false)
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: '<p>alpha</p><p>bravo</p>' }] })
    await h.frames()[0].evaluate(installFragmentProbe, false)
    await h.frames()[0].evaluate(() => (window as unknown as EditorWindow).setWritingZoom(0.5))
    const original = await h.frames()[0].evaluate(measureFragmentPaperText)
    await h.page.evaluate(cloneFragmentPaperWithoutEngine)
    await h.page.waitForFunction(() => {
      const doc = document.querySelector('iframe')!.contentDocument
      return doc?.URL === 'about:srcdoc' && doc.readyState === 'complete'
    })
    const frame = h.frames()[0]
    const geometry = await frame.evaluate(measureFragmentPaperText)
    expect(geometry).toEqual(original)
    expect(geometry.points[0]).toEqual({ x: 603.6875, y: 56.75 })
    expect(geometry.viewport).toMatchObject({ top: 0, left: 0 })
    const engineFree = await frame.evaluate(() => document.scripts.length === 0 && !('NovalistEditorState' in window))
    expect(engineFree).toBe(true)
    await frame.evaluate(installFragmentMouseProbe)
    await frame.evaluate(() => document.getElementById('editor')!.focus({ preventScroll: true }))
    const box = await h.page.locator('iframe').boundingBox()
    if (!box) throw new Error('Missing native fixture frame geometry')
    const [start, end] = geometry.points.map(point => ({ x: box.x + point.x, y: box.y + point.y }))
    await h.page.mouse.move(start.x, start.y)
    await h.page.mouse.down()
    const down = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
    await h.page.mouse.move(end.x, end.y, { steps: Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2) })
    const moved = await frame.evaluate(() => window.writingFragmentMouse.snapshot())
    await h.page.mouse.up()
    const result = await frame.evaluate(() => ({ first: window.writingFragmentMouse.snapshot(), events: window.writingFragmentMouse.events }))
    await writeFile(info.outputPath('fragment-zoom-same-line.json'), JSON.stringify({ provenance: writingProvenance(),
      workload: { route: 'script-free-srcdoc', appliedAdaptations: false, zoom: 0.5, panes: 1, scenes: 1, words: 2 }, engineFree, geometry, down, moved, ...result }, null, 2))
    expect(down).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 0, focusOffset: 2, collapsed: true })
    expect(moved).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 0, focusOffset: 5, collapsed: false })
    expect(result.first).toEqual(moved)
  } finally { await h.close() }
})

for (const conversion of ['scale', 'css-zoom', 'overflow', 'pixels']) test(`fragment native zoom isolation: paired ${conversion} same-line forward drag without probe`, async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_ENGINE !== 'electron', 'Native probe-invariance falsifier.')
  const samples = []
  for (const scale of [0.5, 1]) {
  const h = await launchWriting('original', 1, false)
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: '<p>alpha</p><p>bravo</p>' }] })
    await h.frames()[0].evaluate(installFragmentProbe, false)
    await h.frames()[0].evaluate(() => (window as unknown as EditorWindow).setWritingZoom(0.5))
    const originalFonts = await h.frames()[0].evaluate(async () => { await document.fonts.ready; return document.fonts.status })
    const original = await h.frames()[0].evaluate(measureFragmentPaperText)
    await h.page.evaluate(cloneFragmentPaperWithoutEngine)
    await h.page.waitForFunction(() => {
      const doc = document.querySelector('iframe')!.contentDocument
      return doc?.URL === 'about:srcdoc' && doc.readyState === 'complete'
    })
    const frame = h.frames()[0]
    const clonedFonts = await frame.evaluate(async () => { await document.fonts.ready; return document.fonts.status })
    const cloned = await frame.evaluate(measureFragmentPaperText)
    await writeFile(info.outputPath(`fragment-zoom-scale-${scale}-precondition.json`), JSON.stringify({ provenance: writingProvenance(), scale, originalFonts, clonedFonts, original, cloned }, null, 2))
    expect(originalFonts).toBe('loaded')
    expect(clonedFonts).toBe('loaded')
    expect(cloned).toEqual(original)
    const layout = await frame.evaluate(({ scale, conversion }) => {
      const root = document.getElementById('editor')!
      const before = root.getBoundingClientRect()
      const origin = getComputedStyle(root).transformOrigin.split(' ').map(parseFloat)
      const untransformed = () => ({ width: root.offsetWidth, height: root.offsetHeight, origin: getComputedStyle(root).transformOrigin,
        paragraphs: Array.from(root.querySelectorAll<HTMLElement>('p'), node => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight]) })
      const previous = untransformed()
      if (scale === 1) {
        if (conversion === 'overflow') document.querySelector<HTMLElement>('.writing-zoom-surface')!.style.overflow = 'hidden'
        else if (conversion !== 'pixels') {
          root.style.transform = 'scale(1)'
          if (conversion === 'css-zoom') root.style.zoom = '0.5'
        }
      }
      const surface = document.querySelector<HTMLElement>('.writing-zoom-surface')!
      return { previous, next: untransformed(), origin: { x: before.left + origin[0] * 0.5, y: before.top + origin[1] * 0.5 },
        surface: { overflow: getComputedStyle(surface).overflow, top: surface.scrollTop, left: surface.scrollLeft },
        viewport: document.getElementById('editor-wrapper')!.getBoundingClientRect().toJSON() }
    }, { scale, conversion })
    const geometry = await frame.evaluate(measureFragmentPaperText)
    await writeFile(info.outputPath(`fragment-zoom-scale-${scale}-geometry.json`), JSON.stringify({ scale, layout, geometry }, null, 2))
    expect(layout.next).toEqual(layout.previous)
    expect(geometry.viewport).toMatchObject({ top: 0, left: 0 })
    if (conversion !== 'scale') expect({ ...geometry, transform: original.transform }).toEqual(original)
    if (conversion === 'overflow') expect(layout.surface).toEqual({ overflow: scale === 1 ? 'hidden' : 'clip', top: 0, left: 0 })
    const measuredScale = conversion === 'scale' ? scale : 0.5
    for (const [index, point] of geometry.points.entries()) {
      expect(point.x).toBeCloseTo(layout.origin.x + (original.points[index].x - layout.origin.x) * measuredScale / 0.5, 3)
      expect(point.y).toBeCloseTo(layout.origin.y + (original.points[index].y - layout.origin.y) * measuredScale / 0.5, 3)
      expect(point.x).toBeGreaterThan(layout.viewport.left)
      expect(point.x).toBeLessThan(layout.viewport.right)
      expect(point.y).toBeGreaterThan(layout.viewport.top)
      expect(point.y).toBeLessThan(layout.viewport.bottom)
    }
    const engineFree = await frame.evaluate(() => document.scripts.length === 0 && !('NovalistEditorState' in window) && !('writingFragmentMouse' in window))
    expect(engineFree).toBe(true)
    await frame.evaluate(() => document.getElementById('editor')!.focus({ preventScroll: true }))
    const box = await h.page.locator('iframe').boundingBox()
    if (!box) throw new Error('Missing native fixture frame geometry')
    const [start, end] = geometry.points.map(point => ({ x: box.x + point.x, y: box.y + point.y }))
    const dpr = await frame.evaluate(() => window.devicePixelRatio)
    const path = Array.from({ length: 8 }, (_, index) => {
      const x = start.x + (end.x - start.x) * index / 7
      const y = start.y + (end.y - start.y) * index / 7
      return conversion === 'pixels' && scale === 1 ? { x: Math.round(x * dpr) / dpr, y: Math.round(y * dpr) / dpr } : { x, y }
    })
    const hitTests = conversion === 'pixels' ? await frame.evaluate(points => points.map(point => {
      const legacy = document.caretRangeFromPoint(point.x, point.y)
      const modern = document.caretPositionFromPoint?.(point.x, point.y)
      const text = document.querySelector('#editor p')!.firstChild
      return { available: typeof document.caretPositionFromPoint === 'function', sameText: modern?.offsetNode === text, offset: modern?.offset,
        legacy: { sameText: legacy?.startContainer === text, offset: legacy?.startOffset } }
    }), [path[0], path[7]].map(point => ({ x: point.x - box.x, y: point.y - box.y }))) : null
    await writeFile(info.outputPath(`fragment-zoom-scale-${scale}-input-precondition.json`), JSON.stringify({ conversion, scale, dpr, path, hitTests }, null, 2))
    if (hitTests) expect(hitTests).toMatchObject([{ available: true, sameText: true, offset: 2 }, { available: true, sameText: true, offset: 5 }])
    await h.page.mouse.move(path[0].x, path[0].y)
    await h.page.mouse.down()
    if (conversion === 'pixels') for (const point of path.slice(1)) await h.page.mouse.move(point.x, point.y)
    else await h.page.mouse.move(end.x, end.y, { steps: Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2) })
    await h.page.mouse.up()
    const result = await frame.evaluate(() => {
      const selection = window.getSelection()!
      const nodes: (Node | null)[] = Array.from(document.querySelectorAll('#editor p'), paragraph => paragraph.firstChild)
      const surface = document.querySelector<HTMLElement>('.writing-zoom-surface')!
      return { anchor: nodes.indexOf(selection.anchorNode), anchorOffset: selection.anchorOffset,
        focus: nodes.indexOf(selection.focusNode), focusOffset: selection.focusOffset, collapsed: selection.isCollapsed,
        scroll: document.getElementById('editor-wrapper')!.scrollTop, surfaceScroll: { top: surface.scrollTop, left: surface.scrollLeft } }
    })
    samples.push({ scale, engineFree, layout, geometry, dpr, path, hitTests, result })
    await writeFile(info.outputPath(`fragment-zoom-scale-${scale}-gesture.json`), JSON.stringify({ provenance: writingProvenance(), scale, engineFree, layout, geometry, dpr, path, hitTests, result }, null, 2))
    expect(result.surfaceScroll).toEqual({ top: 0, left: 0 })
    if (scale === 0.5) expect(result).toMatchObject({ anchor: 0, anchorOffset: 5, focus: 0, focusOffset: 5, collapsed: true, scroll: 0 })
  } finally { await h.close() }
  }
  await writeFile(info.outputPath('fragment-zoom-scale-pair.json'), JSON.stringify({ provenance: writingProvenance(),
    workload: { route: 'script-free-srcdoc', conversion, appliedAdaptations: false, eventProbe: false, interGestureEvaluation: false, panes: 1, scenes: 1, words: 2 }, samples }, null, 2))
  expect(samples[0].result).toMatchObject({ anchor: 0, anchorOffset: 5, focus: 0, focusOffset: 5, collapsed: true, scroll: 0 })
  expect(samples[1].result).toMatchObject({ anchor: 0, anchorOffset: 2, focus: 0, focusOffset: 5, collapsed: false, scroll: 0 })
})
