import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: { resolveDir: directory, loader: 'tsx', contents: `
    import React, { act } from 'react'
    import { createRoot } from 'react-dom/client'
    import { SceneConflictDialog } from './src/renderer/src/shell/SceneConflictDialog'
    import { useProjectStore } from './src/renderer/src/stores/projectStore'
    import { createProjectEditorActions } from './src/renderer/src/stores/projectEditorActions'
    import { refreshExternalScenes } from './src/renderer/src/stores/externalSceneRefresh'
    let root, owner, focusRead
    const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
    export function edit(html) {
      const before = owner.getSnapshot(ref)
      owner.apply({ id: crypto.randomUUID(), context: owner.context, origin: 'writer', kind: 'input',
        changes: [{ ref, expectedRevision: before.revision, beforeHtml: before.html, afterHtml: html }],
        annotationChanges: [], beforeSelection: null, afterSelection: null })
    }
    export async function mount() {
      useProjectStore.setState(createProjectEditorActions(useProjectStore.setState, useProjectStore.getState))
      owner = useProjectStore.getState().getWritingRegistry()
      await owner.read(ref)
      root = createRoot(document.getElementById('host'))
      await act(async () => root.render(<SceneConflictDialog />))
      window.addEventListener('focus', () => { focusRead = refreshExternalScenes() })
    }
    export async function focus() { await act(async () => { window.dispatchEvent(new Event('focus')); await focusRead }) }
    export async function startFocus() { await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve() }) }
    export async function finishFocus() { await act(async () => { await focusRead }) }
    export async function click(element) { await act(async () => { element.click(); await Promise.resolve() }) }
    export async function escape() { await act(async () => document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))) }
    export async function close() { await owner.flush(); await owner.close() }
    export async function save() { await act(async () => owner.flush()) }
    export { writingSavedCounts } from './src/renderer/src/stores/writingSavedCounts'
    export async function unmount() { await act(async () => root.unmount()) }
    export const state = () => useProjectStore.getState()
    export const snapshot = () => owner.getSnapshot(ref)
    export const dirty = () => owner.isDirty
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'conflictFixture',
  jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'conflict-boundaries', setup(builder) {
    const sources = {
      projectStore: `import { create } from 'zustand';
        export const useProjectStore = create(() => ({ isLoaded: true, workspaceEpoch: 1, projectPath: 'project',
          activeBookId: 'book', activeDraftId: 'draft', sceneConflict: null, sceneHashes: {}, editors: {},
          chapters: [{ guid: 'chapter', scenes: [{ id: 'scene', wordCount: 0 }] }] }));
        export const mirror = () => ({}); export const mapEditors = (editors, fn) => Object.fromEntries(Object.entries(editors).map(([id, value]) => [id, fn(value)]));
        export const EMPTY_EDITOR = {}; export const editorPane = () => ({}); export const patchEditor = () => ({});
        export const writePaneIds = () => []; export const targetEditorPane = () => 'pane';`,
      shellStore: `export const paneLeaves = () => []; export const useShellStore = { getState: () => ({}) };`,
      projectSceneActions: `export const runSceneContext = async run => run();`,
      writingSceneNavigation: `export const revealWritingSceneInPane = async () => {}; export const widenWritingRunForScene = async () => {};`,
      manuscriptStore: `export const useManuscriptStore = { getState: () => ({ sections: [] }) }; export const applyExternalManuscriptScene = () => {};`,
      sharedEditors: `export const flushSharedEditor = async () => {};`,
      recovery: `export const retainMobileSceneRecovery = () => {}; export const acknowledgeMobileSceneRecovery = () => {};`,
      client: `export const rpc = { request: (method, params) => window.request(method, params), onNotification: () => () => {} };`,
      MotionPresence: `export function MotionPresence({ children }) { return children } export const useMotionPresent = () => true;`,
      'react-i18next': `export const useTranslation = () => ({ t: key => key });`
    }
    builder.onResolve({ filter: /./ }, args => {
      if (!args.path.startsWith('.') && args.path !== 'react-i18next') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }]
})

const mine = '<p>Mine first</p><p>Mine second</p>'
const theirs = '<p>Disk first</p><p>Disk second</p>'

for (const { choice, delayedCounts } of [
  { choice: 'theirs', delayedCounts: false }, { choice: 'mixed', delayedCounts: false },
  { choice: 'theirs', delayedCounts: true }, { choice: 'mixed', delayedCounts: true }
]) test(`lost ${choice} resolution retries identically${delayedCounts ? ' without reopening after delayed counts' : ' after dismissal'}`, { timeout: 5000 }, async t => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  const view = dom.window
  const channels = []
  view.MessageChannel = class extends MessageChannel {
    constructor() { super(); channels.push(this) }
  }
  view.IS_REACT_ACT_ENVIRONMENT = true
  view.structuredClone = structuredClone
  view.novalist = { isMobile: false }
  let disk = '<p>Original</p>', lost = true
  let holdCounts = false, releaseCounts
  const requests = []
  view.request = async (method, params) => {
    if (method === 'scenes/readPassive') return { html: disk, hash: disk }
    if (method === 'scenes/refresh') return holdCounts ? new Promise(resolve => { releaseCounts = resolve }) : { counts: [] }
    if (method === 'scenes/mergeRows') return [
      { mine: 'Mine first', theirs: 'Disk first', mineHtml: '<p>Mine first</p>', theirsHtml: '<p>Disk first</p>', state: 'changed' },
      { mine: 'Mine second', theirs: 'Disk second', mineHtml: '<p>Mine second</p>', theirsHtml: '<p>Disk second</p>', state: 'changed' }
    ]
    if (method === 'writing/resolveConflict') {
      const request = structuredClone(params[0])
      requests.push(request)
      disk = request.html
      if (lost) { lost = false; throw new Error('Lost acknowledgement') }
      return { status: 'committed', operationId: request.transactionId, hashes: [{ ref: request.ref, hash: disk }] }
    }
    if (method === 'writing/commit') {
      const request = params[0]
      assert.equal(request.changes[0].expectedHash, disk)
      disk = request.changes[0].afterHtml
      return { status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: disk })) }
    }
    assert.fail(`Unexpected RPC ${method}`)
  }
  view.eval(bundle.outputFiles[0].text)
  const app = view.conflictFixture
  t.after(async () => {
    await app.unmount(); view.close()
    for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  })
  await app.mount()
  app.edit(mine)
  disk = theirs
  if (delayedCounts) {
    holdCounts = true
    await app.startFocus()
    const latestMine = mine + '<p>Typed while counts wait</p>'
    app.edit(latestMine)
    holdCounts = false
    releaseCounts({ counts: [] })
    await app.finishFocus()
    assert.equal(app.state().sceneConflict.mine, latestMine, 'ordinary conflicts must include typing after their passive read')
    app.edit(mine)
  } else await app.focus()
  const button = key => Array.from(view.document.querySelectorAll('button')).find(element => element.textContent === key)
  await app.click(button('conflict.decideLater'))
  assert.equal(view.document.querySelector('[role="dialog"]'), null)
  assert.equal(requests.length, 0, 'dismissing an ordinary conflict sends no resolution')
  await app.focus()
  if (choice === 'theirs') await app.click(button('conflict.takeAllTheirs'))
  else await app.click(view.document.querySelectorAll('.scene-conflict-cell')[3])
  await app.click(button('conflict.save'))
  assert.equal(requests.length, 1)
  const chosen = choice === 'theirs' ? theirs : '<p>Mine first</p><p>Disk second</p>'
  assert.equal(requests[0].html, chosen)
  if (choice === 'theirs') await app.click(button('conflict.decideLater'))
  else await app.escape()
  assert.equal(view.document.querySelector('[role="dialog"]'), null)
  if (delayedCounts) { holdCounts = true; await app.startFocus() }
  else await app.focus()
  assert.ok(view.document.querySelector('[role="dialog"]'), 'refocus must reopen the retained resolution')
  assert.equal(app.state().sceneConflict.writing.resolution.html, chosen)
  assert.equal(button('conflict.takeAllMine'), undefined, 'an uncertain choice cannot be replaced')
  assert.ok(view.document.querySelector('.scene-conflict-pending').textContent.includes(choice === 'mixed' ? 'Mine first' : 'Disk first'))
  await app.click(button('shell.retry'))
  assert.deepEqual(requests[1], requests[0])
  assert.equal(view.document.querySelector('[role="dialog"]'), null)
  if (delayedCounts) {
    releaseCounts({ counts: [] })
    await app.finishFocus()
    assert.equal(view.document.querySelector('[role="dialog"]') === null, true, 'late counts must not reopen a completed resolution')
    assert.equal(requests.length, 2)
  }
  assert.equal(app.snapshot().html, chosen)
  app.edit('<p>After resolution</p>')
  await app.close()
  assert.equal(disk, '<p>After resolution</p>')
  assert.equal(app.dirty(), false)
})


test('saved canonical counts survive a held older focus refresh and clearing prose', { timeout: 5000 }, async t => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  const view = dom.window
  const channels = []
  view.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  view.IS_REACT_ACT_ENVIRONMENT = true
  view.structuredClone = structuredClone
  view.novalist = { isMobile: false }
  let disk = '<p>Original text.</p>', releaseCounts
  view.request = async (method, params) => {
    if (method === 'scenes/readPassive') return { html: disk, hash: disk }
    if (method === 'scenes/refresh') return new Promise(resolve => { releaseCounts = resolve })
    if (method === 'writing/commit') {
      const request = params[0]
      disk = request.changes[0].afterHtml
      return { status: 'committed', hashes: request.changes.map(change => ({ ref: change.ref, hash: disk })) }
    }
    assert.fail(`Unexpected RPC ${method}`)
  }
  view.eval(bundle.outputFiles[0].text)
  const app = view.conflictFixture
  t.after(async () => { await app.unmount(); view.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  await app.mount()
  assert.equal(app.state().chapters[0].scenes[0].wordCount, 0, 'initial reads preserve supplied metadata without parsing each scene')
  await app.startFocus()
  app.edit('<p>The newest saved scene contains exactly nine whole words.</p>')
  assert.equal(app.state().chapters[0].scenes[0].wordCount, 0, 'binder retains save-based counts')
  await app.save()
  assert.equal(app.state().chapters[0].scenes[0].wordCount, 9)
  releaseCounts({ counts: [{ sceneId: 'scene', wordCount: 2, hash: '<p>Original text.</p>' }] })
  await app.finishFocus()
  assert.equal(app.state().chapters[0].scenes[0].wordCount, 9)
  app.edit('<p><br></p>')
  await app.save()
  assert.equal(app.state().chapters[0].scenes[0].wordCount, 0)
  const state = app.state(), snapshot = { ...app.snapshot(), html: '<p>One</p><p>two</p><del data-nl-change="delete">gone</del>' }
  const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  assert.equal(app.writingSavedCounts(state, context, snapshot).chapters[0].scenes[0].wordCount, 2)
  const sharedState = { ...state, chapters: [{ guid: 'chapter', scenes: [{ id: 'scene', sharedProse: { itemId: 'shared' } }] }] }
  assert.equal(Object.keys(app.writingSavedCounts(sharedState, context, snapshot)).length, 0)
  for (const patch of [{ projectPath: 'other' }, { workspaceEpoch: 2 }, { activeBookId: 'other' }, { activeDraftId: 'other' }]) {
    assert.equal(Object.keys(app.writingSavedCounts({ ...state, ...patch }, context, snapshot)).length, 0)
  }
  for (const patch of [{ bookId: 'other' }, { draftId: 'other' }, { chapterGuid: 'other' }, { sceneId: 'other' }, { shared: { itemId: 'shared' } }]) {
    assert.equal(Object.keys(app.writingSavedCounts(state, context, { ...snapshot, ...patch })).length, 0)
  }
  await app.close()
})
