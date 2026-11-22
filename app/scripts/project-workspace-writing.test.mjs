import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

function fixture(isMobile = false) {
  const reads = []
  let state = { workspaceEpoch: 3, projectPath: 'project', activeBookId: 'book', activeDraftId: 'draft',
    editors: { a: { chapterGuid: 'first', sceneId: 'a', html: 'old' }, b: { chapterGuid: 'second', sceneId: 'b', html: 'old' } },
    dirtyMap: {}, sceneHashes: {}, activeEditorPaneId: 'a' }
  const registry = { context: { bookId: 'book', draftId: 'draft' },
    read: async ref => { reads.push(['passive', ref]); return { html: `canonical-${ref.sceneId}`, hash: `hash-${ref.sceneId}` } } }
  state.getWritingRegistry = () => registry
  const set = value => { state = { ...state, ...(typeof value === 'function' ? value(state) : value) } }
  const actions = loadRendererSource('src/stores/projectWorkspaceActions.ts', {
    '../rpc/client': { rpc: { request: async (method, params) => { reads.push([method, params]); return { html: 'mobile', hash: 'mobile-hash' } } } },
    './shellStore': {}, './settingsStore': {}, './codexStore': {}, './pendingWrites': {}, '../i18n': {},
    './projectPersistence': { stripHtml: html => html }, './projectSceneActions': {},
    './projectStore': { mapEditors: (editors, update) => Object.fromEntries(Object.entries(editors).map(([id, editor]) => [id, update(editor)])), mirror: () => ({}) }
  }, { window: { novalist: { isMobile } } }).createProjectWorkspaceActions(set, () => state)
  return { actions, reads, registry, state: () => state, set }
}

test('desktop recovery and structural resume hydrate every pane passively with full references', async () => {
  for (const preserveDirty of [false, true]) {
    const windows = [fixture(), fixture()]
    await Promise.all(windows.map(window => window.actions.refreshWorkspaceEditors(preserveDirty)))
    for (const window of windows) {
      assert.deepEqual(structuredClone(window.reads), ['a', 'b'].map((sceneId, index) => ['passive', {
        bookId: 'book', draftId: 'draft', chapterGuid: index === 0 ? 'first' : 'second', sceneId
      }]))
      assert.equal(window.state().editors.a.html, 'canonical-a')
      assert.equal(window.state().editors.b.html, 'canonical-b')
    }
  }
})

test('mobile workspace hydration retains its existing activating scene adapter', async () => {
  const f = fixture(true)
  await f.actions.refreshWorkspaceEditors()
  assert.deepEqual(structuredClone(f.reads), [['scenes/read', ['first', 'a']], ['scenes/read', ['second', 'b']]])
})

test('a delayed desktop refresh cannot publish into another book at the same epoch', async () => {
  const f = fixture()
  let release
  const waiting = new Promise(resolve => { release = resolve })
  f.registry.read = async () => { await waiting; return { html: 'stale', hash: 'stale' } }
  const refreshing = f.actions.refreshWorkspaceEditors(true)
  f.set({ activeBookId: 'other' })
  release()
  await refreshing
  assert.equal(f.state().editors.a.html, 'old')
})
