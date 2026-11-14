import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import type { WritingPane } from './fixtures/writingContract'
import type { SceneProjection } from './fixtures/writingSceneSurface'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'

test.beforeEach(() => { test.skip(process.env.NOVALIST_WRITING_FRAGMENTS !== '1', 'Requires the explicit fragment adapter route') })

for (const zoom of [0.75, 1.1]) test(`fragment layout: nested, empty, oversized and authored inline content at zoom ${zoom}`, async () => {
  const h = await launchWriting('experiment', 2, false)
  try {
    const scenes = [
      { id: 'empty', html: '<p><br></p>' },
      { id: 'inline', html: 'alpha <em>bravo</em> <strong>charlie</strong>' },
      { id: 'nested', html: '<ul><li>one<ul><li>two</li></ul></li></ul><table><tbody><tr><td>three</td><td>four</td></tr></tbody></table><figure><img width="80" height="80" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><figcaption>five</figcaption></figure><p style="margin:3em 0 !important">six</p>' },
      { id: 'oversized', html: '<div style="height:60em">oversized</div>' },
      { id: 'tail', html: '<p>tail</p>' }
    ]
    await h.seed({ wordCount: 11, scenes })
    const before = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    const result = await h.frames()[0].evaluate(zoom => {
      const root = document.getElementById('editor')!
      const originals = Array.from(root.querySelectorAll('[data-writing-fragment]')).flatMap(fragment => Array.from(fragment.childNodes))
      const editor = window as unknown as EditorWindow
      editor.setPageView(true)
      editor.setWritingZoom(zoom)
      const pages = Array.from(root.querySelectorAll<HTMLElement>(':scope > .nv-page'), page => {
        const box = page.getBoundingClientRect()
        const scale = box.width / page.offsetWidth
        const style = getComputedStyle(page)
        const top = box.top + parseFloat(style.paddingTop) * scale
        const bottom = top + 48 * parseFloat(getComputedStyle(root).fontSize) * scale
        const atoms = Array.from(page.querySelectorAll(':scope > [data-writing-fragment]')).flatMap(fragment => Array.from(fragment.childNodes))
        const oversized = atoms.length === 1 && atoms[0].nodeType === 1 && (atoms[0] as HTMLElement).style.height === '60em'
        const range = document.createRange()
        return { oversized, count: atoms.length, fit: atoms.every(atom => { range.selectNode(atom); return Array.from(range.getClientRects()).every(rect => rect.top >= top - 0.1 && rect.bottom <= bottom + 0.1) }) }
      })
      const empty = root.querySelector<HTMLElement>('[data-scene-id="empty"] p')!
      const emptyHeight = empty.getBoundingClientRect().height
      window.parent.writingPanes[0].scope([])
      const hidden = originals.every(node => node.isConnected && !node.parentElement!.getClientRects().length)
      window.parent.writingPanes[0].scope([0, 1, 2, 3, 4])
      return { pages, emptyHeight, hidden, retained: originals.every(node => node.isConnected), runtimes: window.parent.document.querySelectorAll('iframe').length }
    }, zoom)
    expect(result.pages.filter(page => page.oversized)).toHaveLength(1)
    expect(result.pages.every(page => page.oversized || page.fit)).toBe(true)
    expect(result.emptyHeight).toBeGreaterThan(0)
    expect(result.hidden && result.retained).toBe(true)
    expect(result.runtimes).toBe(2)
    expect(await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))).toEqual(before)
    expect(await h.page.evaluate(() => window.writingPanes[0].inspect().undoGroups)).toEqual([])
  } finally { await h.close() }
})

test('fragment layout: delayed intrinsic image dimensions repack without authored history', async () => {
  const h = await launchWriting('experiment', 1, false)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await h.page.route('**/fragment-delayed.svg', async route => { await gate; await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="650"><rect width="240" height="650" fill="gray"/></svg>' }) })
    await h.seed({ wordCount: 31, scenes: [{ id: 'image', html: '<p>lead paragraph</p>'.repeat(15) + '<figure><img src="http://127.0.0.1:38917/fragment-delayed.svg"></figure>' }] })
    await h.frames()[0].evaluate(() => (window as unknown as EditorWindow).setPageView(true))
    const before = await h.page.evaluate(() => window.writingPanes[0].serialize())
    release()
    await expect.poll(() => h.frames()[0].evaluate(() => document.querySelector('img')!.naturalHeight)).toBe(650)
    await expect.poll(() => h.frames()[0].evaluate(() => {
      const image = document.querySelector('img')!
      const page = image.closest<HTMLElement>('.nv-page')!
      const style = getComputedStyle(page)
      const top = page.getBoundingClientRect().top + parseFloat(style.paddingTop)
      return image.getBoundingClientRect().bottom <= top + 48 * parseFloat(getComputedStyle(document.getElementById('editor')!).fontSize) + 0.1
    })).toBe(true)
    expect(await h.page.evaluate(() => window.writingPanes[0].serialize())).toEqual(before)
    expect(await h.page.evaluate(() => window.writingPanes[0].inspect().undoGroups)).toEqual([])
  } finally { release(); await h.close() }
})

test('fragment layout: pagehide cancels pending layout and clears fragment ownership', async () => {
  const h = await launchWriting('experiment', 1, false)
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'owner', html: '<p>alpha bravo</p>' }] })
    const result = await h.page.evaluate(async () => {
      const pane = window.writingPanes[0] as WritingPane & { projection: SceneProjection }
      const frame = document.querySelector('iframe')!.contentWindow!
      const editor = frame as unknown as EditorWindow & { schedulePageViewRepaginate(): void }
      editor.setPageView(true)
      const node = frame.document.querySelector('p')!.firstChild!
      const before = frame.document.getElementById('editor')!.innerHTML
      const wrappers = Array.from(frame.document.querySelectorAll('.nv-page, [data-writing-fragment]'))
      editor.schedulePageViewRepaginate()
      frame.dispatchEvent(new PageTransitionEvent('pagehide'))
      const released = pane.projection.owner(node) === null && pane.projection.scenes.length === 0
      await new Promise(resolve => setTimeout(resolve, 180))
      return { released, unchanged: frame.document.getElementById('editor')!.innerHTML === before && wrappers.every(wrapper => wrapper.isConnected) }
    })
    expect(result).toEqual({ released: true, unchanged: true })
  } finally { await h.close() }
})

test('fragment mapper: table descendant creation retains sanitizer context', async ({}, info) => {
  const initial = process.env.NOVALIST_WRITING_FRAGMENTS
  const samples = []
  const html = '<table><thead><tr><th>head</th></tr></thead><tbody><tr><td>alpha</td><td>bravo</td></tr></tbody><tfoot><tr><td>foot</td></tr></tfoot></table>'
  try {
    for (const fragments of ['0', '1']) {
      process.env.NOVALIST_WRITING_FRAGMENTS = fragments
      const h = await launchWriting('experiment', 2, false)
      try {
        let error: string | null = null
        try { await h.seed({ wordCount: 4, scenes: [{ id: 'table', html }] }) }
        catch (caught) { error = caught instanceof Error ? caught.message.split('\n')[0] : String(caught) }
        const sanitizer = await h.frames()[0].evaluate(() => ['table', 'tbody', 'tr', 'td', 'ul', 'li'].map(tag => {
          const fragment = (window as unknown as EditorWindow).sanitizeSceneFragment(`<${tag}></${tag}>`)
          return { tag, elements: Array.from(fragment.children, child => child.tagName) }
        }))
        samples.push({ fragments, error, sanitizer })
        if (error === null) expect(await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()[0].html))).toEqual([html, html])
      } finally { await h.close() }
    }
  } finally { process.env.NOVALIST_WRITING_FRAGMENTS = initial }
  await writeFile(info.outputPath('fragment-table-context.json'), JSON.stringify({ provenance: writingProvenance(), samples }, null, 2))
  expect(samples[1].error).toBeNull()
  expect(samples[0].error).toContain('Unsupported shared paragraph')
})
