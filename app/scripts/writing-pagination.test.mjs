import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { transform } from 'esbuild'

const transformed = await transform(readFileSync(new URL('../src/renderer/src/collaboration/richEditingSurface.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm' })
const { sharedWritingSceneSurface } = await import('data:text/javascript;base64,' + Buffer.from(transformed.code).toString('base64'))

function runtime(t) {
  const dom = new JSDOM('<div id="editor-wrapper"><div id="editor" contenteditable="true"><section data-writing-scene="a"><p>First prose</p></section><section data-writing-scene="b"><p>Second prose</p></section><section data-writing-scene="c"><p>Third prose</p></section></div></div>', { runScripts: 'outside-only' })
  const w = dom.window
  t.after(() => w.close())
  const jobs = []
  const measured = []
  Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
    measured.push(this.closest('[data-writing-scene]')?.dataset.writingScene)
    return 0
  } })
  w.setTimeout = callback => { jobs.push(callback); return jobs.length }
  w.NovalistEditorState = { editor: w.document.getElementById('editor'), wrapper: w.document.getElementById('editor-wrapper'), pageViewEnabled: false }
  w.NovalistWritingDocument = { enabled: true }
  w.writingSceneOf = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-writing-scene]')
  w.getWritingSceneRoot = id => w.document.querySelector(`[data-writing-scene="${id}"]`)
  w.writingServiceState = () => ({ visibleSceneIds: ['a', 'b', 'c'], selectedSceneIds: ['a'], activeSceneId: 'a' })
  w.captureDictationPosition = () => null
  w.restoreDictationPosition = () => {}
  w.reapplyReadability = () => {}
  w.eval(readFileSync(new URL('../src/renderer/public/editor/editor-content.js', import.meta.url), 'utf8'))
  w.eval(readFileSync(new URL('../src/renderer/public/editor/page-layout.js', import.meta.url), 'utf8'))
  w.setPageView(true)
  measured.length = 0
  const flush = () => { for (const callback of jobs.splice(0)) callback() }
  return { w, jobs, measured, flush, root: id => w.getWritingSceneRoot(id), page: id => w.getWritingSceneRoot(id).firstElementChild }
}

test('shared scene layout requests coalesce without synchronously repaginating another scene', t => {
  const { w, jobs, measured, flush, root, page } = runtime(t)
  const before = ['a', 'b', 'c'].map(page)
  const surface = sharedWritingSceneSurface(w, 'b')
  surface.refreshLayout()
  surface.refreshLayout()
  assert.equal(page('b'), before[1], 'shared rendering must not synchronously rebuild pages')
  assert.equal(jobs.length, 1)
  flush()
  assert.equal(page('b'), before[1])
  assert.deepEqual(measured, ['b'])
  assert.equal(page('a'), before[0])
  assert.equal(page('c'), before[2])
  assert.equal(root('b').textContent, 'Second prose')
})

test('shared rendering refreshes ornament presentation only in its scene before queued layout', t => {
  const { w, root, page } = runtime(t)
  root('b').querySelector('p').textContent = '***'
  const other = page('a')
  sharedWritingSceneSurface(w, 'b').refreshLayout()
  assert.equal(root('b').querySelector('p').classList.contains('nv-scene-break'), true)
  assert.equal(root('a').querySelector('.nv-scene-break'), null)
  assert.equal(page('a'), other)
})

test('prose mutations schedule only their scene and keep other page wrappers stable', async t => {
  const { jobs, measured, flush, root, page } = runtime(t)
  const before = ['a', 'b', 'c'].map(page)
  root('b').querySelector('p').append(' edited')
  root('b').querySelector('p').append(' again')
  await Promise.resolve()
  assert.equal(jobs.length, 1)
  flush()
  assert.equal(page('a'), before[0])
  assert.equal(page('b'), before[1])
  assert.deepEqual(measured, ['b'])
  assert.equal(page('c'), before[2])
  assert.equal(root('b').textContent, 'Second prose edited again')
})

test('paginating a different scene leaves a reverse selection untouched', t => {
  const { w, root } = runtime(t)
  const text = root('a').querySelector('p').firstChild
  const selection = w.getSelection()
  selection.setBaseAndExtent(text, 6, text, 1)
  let restores = 0
  const restore = selection.setBaseAndExtent.bind(selection)
  selection.setBaseAndExtent = (...args) => { restores++; restore(...args) }
  w.repaginatePageView(root('b'))
  assert.equal(restores, 0)
  assert.equal(selection.anchorNode, text)
  assert.equal(selection.anchorOffset, 6)
  assert.equal(selection.focusOffset, 1)
})

test('composition protects a queued scene from layout until committed input', t => {
  const { w, measured, flush, root, page } = runtime(t)
  const before = page('b')
  w.schedulePageViewRepaginate(root('b'))
  w.NovalistEditorState.isComposing = true
  flush()
  assert.equal(page('b'), before)
  assert.deepEqual(measured, [])
  w.NovalistEditorState.isComposing = false
  w.schedulePageViewRepaginate(root('b'))
  flush()
  assert.equal(page('b'), before)
  assert.deepEqual(measured, ['b'])
})

test('offscreen shared edits wait for visibility while global width changes still repaginate visible prose', t => {
  const { w, measured, flush, root, page } = runtime(t)
  const before = page('b')
  w.writingServiceState = () => ({ visibleSceneIds: ['a'], selectedSceneIds: ['a'], activeSceneId: 'a' })
  w.schedulePageViewRepaginate(root('b'))
  flush()
  assert.equal(page('b'), before)
  assert.deepEqual(measured, [])
  w.writingServiceState = () => ({ visibleSceneIds: ['b'], selectedSceneIds: ['a'], activeSceneId: 'a' })
  w.schedulePageViewRepaginate()
  flush()
  assert.equal(page('b'), before)
  assert.deepEqual(measured, ['b', 'a'])
})

test('unchanged page boundaries retain every prose node and wrapper without resetting the native caret', t => {
  const { w, root } = runtime(t)
  Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return 500 } })
  const scene = root('a')
  scene.append(w.document.createElement('p'), w.document.createElement('p'))
  w.repaginatePageView(scene)
  const pages = [...scene.querySelectorAll('.nv-page')]
  assert.equal(pages.length, 3)
  const prose = [...scene.querySelectorAll('p')]
  const text = prose[0].firstChild
  const selection = w.getSelection()
  selection.setBaseAndExtent(text, 6, text, 1)
  let restores = 0
  const restore = selection.setBaseAndExtent.bind(selection)
  selection.setBaseAndExtent = (...args) => { restores++; restore(...args) }
  const mutations = new w.MutationObserver(() => {})
  mutations.observe(scene, { childList: true, subtree: true })
  for (let index = 0; index < 20; index++) {
    text.appendData('x')
    w.repaginatePageView(scene)
    assert.equal(scene.querySelectorAll('.nv-page').length, pages.length)
    for (const [index, page] of scene.querySelectorAll('.nv-page').entries()) assert.equal(page, pages[index])
    for (const [index, paragraph] of scene.querySelectorAll('p').entries()) assert.equal(paragraph, prose[index])
  }
  assert.equal(mutations.takeRecords().length, 0)
  assert.equal(restores, 0)
  assert.equal(selection.anchorNode, text)
  assert.equal(selection.anchorOffset, 6)
  assert.equal(selection.focusOffset, 1)
  mutations.disconnect()
})

test('changed block geometry regroups existing nodes and preserves reverse selection and bare text order', t => {
  const { w, root } = runtime(t)
  let height = 500
  Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return height } })
  w.Range.prototype.getBoundingClientRect = () => ({ height: 10 })
  const scene = root('a'), paragraph = scene.querySelector('p')
  const second = w.document.createElement('p')
  second.innerHTML = '<b>second</b><img src="data:image/png;base64,AA==">'
  scene.append(w.document.createTextNode('between'), second, w.document.createTextNode('after'))
  w.repaginatePageView(scene)
  const pages = [...scene.querySelectorAll('.nv-page')]
  assert.equal(pages.length, 2)
  const text = second.querySelector('b').firstChild
  w.getSelection().setBaseAndExtent(text, 5, text, 1)
  height = 100
  w.repaginatePageView(scene)
  assert.equal(scene.querySelectorAll('.nv-page').length, 1)
  assert.equal(scene.firstChild, pages[0])
  assert.deepEqual([...scene.querySelectorAll('p')], [paragraph, second])
  assert.equal(scene.textContent, 'First prosebetweensecondafter')
  assert.equal(w.getSelection().anchorNode, text)
  assert.equal(w.getSelection().anchorOffset, 5)
  assert.equal(w.getSelection().focusOffset, 1)
  height = 500
  w.repaginatePageView(scene)
  assert.equal(scene.querySelectorAll('.nv-page').length, 2)
  assert.equal(scene.firstChild, pages[0])
  assert.equal(scene.querySelector('img'), second.lastChild)
})

test('nested and empty presentation pages normalize without replacing ordinary pages or prose', t => {
  const { w, root, page } = runtime(t)
  const scene = root('a'), outer = page('a'), paragraph = scene.querySelector('p')
  const inner = w.document.createElement('div')
  inner.className = 'nv-page'
  inner.append(paragraph)
  outer.append(inner)
  const empty = inner.cloneNode(false)
  outer.append(empty)
  w.repaginatePageView(scene)
  assert.equal(scene.querySelectorAll('.nv-page').length, 1)
  assert.equal(page('a'), outer)
  assert.equal(outer.firstChild, paragraph)
  paragraph.remove()
  w.repaginatePageView(scene)
  assert.equal(scene.querySelectorAll('.nv-page').length, 0)
  assert.equal(scene.textContent, '')
})
