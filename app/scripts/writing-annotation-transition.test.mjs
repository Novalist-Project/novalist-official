import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { loadRendererSource } from './renderer-source-loader.mjs'

const result = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/stores/writingWorkspaceHistory'; export * from './src/renderer/src/stores/pendingWrites'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const writing = module.exports
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const noop = () => {}
const done = async () => {}
const lifecycle = loadRendererSource('src/stores/writingWorkspaceLifecycle.ts', {
  './writingDocuments': writing, './writingHistory': writing,
  '../collaboration/sharedWritingAnnotations': { prepareSharedWritingAnnotationsClose: async () => noop },
  '../collaboration/sharedWritingSessions': { prepareSharedWritingSessionsClose: async () => noop }
})

function fixture(t) {
  const context = { workspaceId: crypto.randomUUID(), workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  let disk = { html: 'Original prose', hash: 'original', annotations: { comments: [], footnotes: [] } }
  const state = { projectPath: context.workspaceId, workspaceEpoch: 1, isLoaded: true, editors: {}, dirtyMap: {},
    chapters: [{ guid: ref.chapterGuid, scenes: [{ id: ref.sceneId }] }], flushPendingSave: done,
    refreshWorkspaceEditors: done, loadRecents: done, loadDrafts: done }
  state.getWritingRegistry = (scope = { ...context, workspaceEpoch: state.workspaceEpoch }) => writing.getWritingDocumentRegistry({
    context: scope, isCurrent: () => true, transport: {
      read: async () => structuredClone(disk),
      commit: async request => {
        for (const change of request.annotationChanges) {
          assert.deepEqual(change.before, disk.annotations)
          disk.annotations = structuredClone(change.after)
        }
        for (const change of request.changes) { disk.html = change.afterHtml; disk.hash = change.afterHtml }
        return { status: 'committed', hashes: request.changes.map(change => ({ ref: change.ref, hash: disk.hash })) }
      }
    }
  })
  state.applyWorkspaceSnapshot = snapshot => { state.workspaceEpoch = snapshot.epoch }
  let event
  const effects = []
  const store = { getState: () => state, setState: patch => Object.assign(state, patch) }
  const deps = {
    react: { useEffect: effect => effects.push(effect), useState: value => [value, noop] }, 'react-dom': { flushSync: fn => fn() },
    '../i18n': { default: { t: text => text } }, '../rpc/client': { rpc: { request: done, onRecovery: noop } },
    '../stores/pendingWrites': writing, '../stores/projectStore': { useProjectStore: store, reportEditingScenes: noop },
    '../stores/manuscriptStore': { resetManuscriptWorkspace: noop, useManuscriptStore: { getState: () => ({ flushPendingSave: done }) } },
    '../stores/codexStore': { useCodexStore: { getState: () => ({ refresh: done }) } },
    '../stores/settingsStore': { useSettingsStore: { getState: () => ({ load: done }) } },
    '../stores/hostBridgeStore': { useHostBridgeStore: { getState: () => ({ pushToast: error => assert.fail(error) }) } },
    './useWorkspaceDialogGuard': { hasWorkspaceDialogDraft: () => false }, './useBackupScheduler': {},
    '../mobile/recovery': { restoreMobileRecovery: done }, './hotkeys': { setHotkeysEnabled: noop },
    '../collaboration/hostedSessionStore': { useHostedSessionStore: { setState: noop } },
    '../stores/writingWorkspaceHistory': writing, '../stores/writingWorkspaceLifecycle': lifecycle,
    '../stores/writingDocuments': writing, '../views/editor/writingSearchLease': {}, '../stores/writingWorkspaceRecovery': {}
  }
  const source = loadRendererSource('src/shell/useWorkspaceWindow.ts', deps, {
    window: { novalist: { isMobile: false, onWorkspaceEvent: listener => { event = listener } } },
    document: { querySelector: () => ({ setAttribute: noop, removeAttribute: noop }) }, setTimeout, clearTimeout
  })
  source.useWorkspaceWindow()
  effects.forEach(effect => effect())
  t.after(async () => {
    for (const registry of writing.getWritingWorkspaceRegistries(context.workspaceId)) await registry.close()
    writing.disposeWritingHistories(context.workspaceId)
  })
  return { state, event: value => event(value), disk: () => disk, importComment: () => {
    disk.annotations.comments.push({ id: 'external', text: 'Imported review', anchorText: 'prose', resolved: false })
  } }
}

for (const reason of ['review/applyComments', 'writing/annotations']) test(`${reason} flushes pending edits, retains prose history, and permits safe edits after external metadata`, async t => {
  const f = fixture(t)
  const original = f.state.getWritingRegistry()
  await original.read(ref)
  const accept = (owner, changes, annotationChanges) => writing.acceptWritingTransaction(owner, {
    id: crypto.randomUUID(), context: owner.context, origin: 'writer', kind: 'input', changes, annotationChanges,
    beforeSelection: null, afterSelection: null
  })
  const before = original.getAnnotations(ref)
  const local = { ...before, comments: [{ id: 'local', text: 'Local note', anchorText: 'prose', resolved: false }] }
  accept(original, [], [{ ref, before, after: local }])
  let pending = true
  original.registerCapture(() => {
    if (!pending) return
    pending = false
    accept(original, [{ ref, expectedRevision: original.getSnapshot(ref).revision, beforeHtml: 'Original prose', afterHtml: 'Pending prose' }], [])
  })
  await f.event({ phase: 'prepare', preparation: { token: 'transition', reason } })
  assert.equal(f.disk().html, 'Pending prose')
  assert.equal(f.disk().annotations.comments[0].id, 'local')
  f.importComment()
  await f.event({ phase: 'changed', snapshot: { epoch: 2 } })
  await f.event({ phase: 'resumed', token: 'transition' })
  const next = f.state.getWritingRegistry()
  await next.read(ref)
  const history = writing.getWritingHistory(next)
  assert.equal((await history.undo()).status, 'applied')
  assert.equal(next.getSnapshot(ref).html, 'Original prose')
  assert.equal(next.getAnnotations(ref).comments.length, 2)
  assert.deepEqual(await history.undo(), { status: 'blocked', reason: 'writing.historyConflict' })
  const annotations = next.getAnnotations(ref)
  accept(next, [], [{ ref, before: annotations, after: { ...annotations, comments: annotations.comments.map(comment => ({ ...comment, resolved: true })) } }])
  await next.flush()
  assert.deepEqual(f.disk().annotations.comments.map(comment => [comment.id, comment.resolved]), [['local', true], ['external', true]])
  await next.close()
  assert.equal(next.isDirty, false)
})
