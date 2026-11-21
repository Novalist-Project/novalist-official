import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const source = buildSync({
  stdin: { contents: "export * from './src/main/pane-windows'; export * from './src/shared/paneWindows'; export * from './src/shared/detachedPane'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, platform: 'node', format: 'esm', write: false
}).outputFiles[0].text
const shared = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const { PaneWindowRegistry, contentFromRequest, placePaneWindow, detachedPaneQuery, readDetachedPaneQuery } = shared

const area = { x: 0, y: 0, width: 1920, height: 1040 }
const right = { x: 1920, y: 0, width: 1920, height: 1040 }

function fakeWindow(bounds = { x: 100, y: 50, width: 720, height: 900 }) {
  return { destroyed: false, bounds, maximized: false, isDestroyed() { return this.destroyed }, getNormalBounds() { return this.bounds }, isMaximized() { return this.maximized } }
}

function registry() {
  let changes = 0
  const value = new PaneWindowRegistry((bounds) => bounds.x >= 1920 ? right : area, () => { changes += 1 })
  return { value, changes: () => changes }
}

const request = { view: 'codex', projectPath: 'P', chapterGuid: null, sceneId: null, extView: { extensionId: 'ext', key: 'board' } }

test('registered windows are listed with their latest reported content and placement', () => {
  const { value, changes } = registry()
  const win = fakeWindow({ x: 2000, y: 40, width: 700, height: 800 })
  value.add(7, win, contentFromRequest(request))
  value.take(7)
  value.report(7, { panes: { kind: 'split', id: 's', direction: 'row', sizes: [40, 60], children: [{ kind: 'leaf', id: 'a', view: 'write', writingScope: 'chapter' }, { kind: 'leaf', id: 'b', view: 'codex' }] },
    activePane: 1, scenes: [{ pane: 0, chapterGuid: 'c1', sceneId: 's1' }], selectedSceneIds: null, extView: null })
  const [listed] = value.list()
  assert.equal(listed.content.panes.kind, 'split')
  assert.deepEqual(listed.content.scenes, [{ pane: 0, chapterGuid: 'c1', sceneId: 's1' }])
  assert.deepEqual(listed.placement, { bounds: { x: 2000, y: 40, width: 700, height: 800 }, maximized: false, workArea: right })
  assert.equal(changes(), 2)
})

test('reports from unregistered windows, unchanged reports and malformed reports are ignored', () => {
  const { value, changes } = registry()
  value.add(1, fakeWindow(), contentFromRequest(request))
  value.take(1)
  value.report(2, contentFromRequest({ ...request, view: 'maps' }))
  value.report(1, contentFromRequest(request))
  value.report(1, { panes: { kind: 'leaf', id: 'x', view: 'not a view' } })
  assert.equal(changes(), 1)
  assert.equal(value.list()[0].content.panes.view, 'codex')
})

test('a restored window collects its recorded content and its reports wait until then', () => {
  const { value } = registry()
  const recorded = contentFromRequest({ ...request, view: 'timeline' })
  value.add(3, fakeWindow(), recorded, true)
  value.report(3, contentFromRequest({ ...request, view: 'write' }))
  assert.equal(value.list()[0].content.panes.view, 'timeline')
  assert.deepEqual(value.take(3), recorded)
  value.report(3, contentFromRequest({ ...request, view: 'maps' }))
  assert.equal(value.list()[0].content.panes.view, 'maps')
})

test('a window that reloads gets back what it last showed instead of starting bare', () => {
  const { value } = registry()
  const split = { panes: { kind: 'split', id: 's', direction: 'row', sizes: [50, 50], children: [{ kind: 'leaf', id: 'a', view: 'write' }, { kind: 'leaf', id: 'b', view: 'timeline' }] },
    activePane: 0, scenes: [], selectedSceneIds: null, extView: null }
  // Restored, then reloaded: the second ask returns the recorded split again.
  value.add(4, fakeWindow(), split, true)
  assert.equal(value.take(4).panes.kind, 'split')
  assert.equal(value.take(4).panes.kind, 'split')
  // Popped out from a request: the first ask defers to the URL, a reload gets
  // the latest report.
  value.add(5, fakeWindow(), contentFromRequest(request))
  assert.equal(value.take(5), null)
  value.report(5, split)
  assert.equal(value.take(5).panes.kind, 'split')
})

test('a window that has not collected its content cannot overwrite it with a report', () => {
  const { value } = registry()
  value.add(6, fakeWindow(), contentFromRequest(request))
  value.report(6, contentFromRequest({ ...request, view: 'maps' }))
  assert.equal(value.list()[0].content.panes.view, 'codex')
})

test('recorded content is bounded: one scene per pane, a capped selection and a capped tree', () => {
  const { normalizePaneWindowContent, MAX_SELECTED_SCENES, MAX_PANE_LEAVES } = shared
  const content = normalizePaneWindowContent({ panes: { kind: 'leaf', id: 'a', view: 'write' }, activePane: 0,
    scenes: Array.from({ length: 5000 }, (_, i) => ({ pane: 0, chapterGuid: 'c', sceneId: `s${i}` })),
    selectedSceneIds: Array.from({ length: MAX_SELECTED_SCENES + 1 }, (_, i) => `s${i}`) })
  assert.equal(content.scenes.length, 1)
  assert.equal(content.selectedSceneIds, null)
  const wide = (depth) => depth === 0 ? { kind: 'leaf', id: 'l', view: 'write' }
    : { kind: 'split', id: 's', direction: 'row', sizes: Array(16).fill(6), children: Array.from({ length: 16 }, () => wide(depth - 1)) }
  assert.equal(normalizePaneWindowContent({ panes: wide(2) }), null, `more than ${MAX_PANE_LEAVES} panes is refused`)
  assert.equal(normalizePaneWindowContent({ panes: wide(1) }).panes.children.length, 16)
})

test('closed and destroyed windows leave the registry', () => {
  const { value } = registry()
  const gone = fakeWindow()
  value.add(1, gone, contentFromRequest(request))
  value.add(2, fakeWindow(), contentFromRequest(request))
  gone.destroyed = true
  assert.equal(value.list().length, 1)
  assert.equal(value.windows().length, 1)
  value.remove(2)
  value.remove(2)
  assert.equal(value.size, 1)
})

test('a recorded window opens on its own display when that display is still there', () => {
  const placed = placePaneWindow({ bounds: { x: 2000, y: 40, width: 700, height: 800 }, maximized: true, workArea: right }, [area, right], area)
  assert.deepEqual(placed, { bounds: { x: 2000, y: 40, width: 700, height: 800 }, maximized: true })
})

test('a window recorded on a display that is gone is brought onto the fallback display', () => {
  const placed = placePaneWindow({ bounds: { x: 4000, y: 2000, width: 700, height: 800 }, maximized: false, workArea: { x: 3840, y: 0, width: 1920, height: 1080 } }, [area], area)
  assert.deepEqual(placed.bounds, { x: 1220, y: 240, width: 700, height: 800 })
})

test('a window partly off its display is moved inside it and never made larger than it', () => {
  const placed = placePaneWindow({ bounds: { x: -300, y: 900, width: 2400, height: 300 }, maximized: false, workArea: null }, [area], right)
  assert.deepEqual(placed.bounds, { x: 0, y: 640, width: 1920, height: 400 })
})

test('the pop-out query carries the extension view and the restore flag through the URL', () => {
  const query = detachedPaneQuery({ ...request, restore: true })
  const read = readDetachedPaneQuery(new URLSearchParams(query))
  assert.deepEqual(read.extView, { extensionId: 'ext', key: 'board' })
  assert.equal(read.restore, true)
  assert.deepEqual(contentFromRequest(read).extView, { extensionId: 'ext', key: 'board' })
  assert.equal(readDetachedPaneQuery(new URLSearchParams({ pane: 'codex', extView: '{' })).extView, null)
})
