import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: { resolveDir: directory, loader: 'tsx', contents: `
    import React, { act } from 'react'
    import { createRoot } from 'react-dom/client'
    import { SuggestionsPanel } from './src/renderer/src/shell/SuggestionsPanel'
    import { InboxPanel } from './src/renderer/src/shell/InboxPanel'
    import { WritingDocumentRegistry, sceneRefKey } from './src/renderer/src/stores/writingDocuments'
    import { observeWritingSuggestionCounts } from './src/renderer/src/shell/writingSuggestionCounts'
    import { useEditorBridge } from './src/renderer/src/stores/editorBridgeStore'
    import { WritingPaneController } from './src/renderer/src/views/editor/writingPaneController'
    import { getWritingHistory } from './src/renderer/src/stores/writingHistory'
    import { SharedSceneSession } from './src/renderer/src/collaboration/SharedSceneSession'
    import { ProseDocumentHost } from './src/shared/ProseDocumentHost'
    import { useProjectStore } from './src/renderer/src/stores/projectStore'
    import * as Y from 'yjs'
    export { act }
    let root, registry, controller, releaseCapture, owner, host, server
    let pending = []
    const context = { workspaceId: '/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
    const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
    export async function initialize(shared, inbox) {
      if (shared) {
        const environment = { document, sanitizeSceneFragment: html => {
          const template = document.createElement('template'); template.innerHTML = html; return template.content
        }, toDisplayImages() {} }
        host = new ProseDocumentHost(document, environment)
        const seed = host.seed('scene', window.initialHtml)
        server = new Y.Doc(); Y.applyUpdate(server, seed)
        owner = new SharedSceneSession(environment, seed, {
          read: async () => Y.encodeStateAsUpdate(server), subscribe: () => () => {},
          write: async update => { window.sharedWrites++; Y.applyUpdate(server, update) }
        })
        window.sharedOwner = owner
      }
      registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
        read: async () => ({ html: owner?.html ?? window.initialHtml, hash: 'saved',
          shared: shared ? { sessionId: 'session', itemId: 'scene', state: '' } : null }),
        activate: async () => true,
        commit: async request => {
          if (shared) throw new Error('Shared review used ordinary disk persistence')
          window.diskHtml = request.changes[0].afterHtml
          return { status: 'committed', operationId: request.transactionId,
            hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) }
        }
      } })
      await registry.read(ref)
      useProjectStore.setState({ ...context, projectPath: context.workspaceId, activeBookId: 'book', activeDraftId: 'draft',
        isLoaded: true, openChapterGuid: 'chapter', openSceneId: 'scene', activeEditorPaneId: 'pane',
        chapters: [{ guid: 'chapter', title: 'Chapter', scenes: [{ id: 'scene', title: 'Scene' }] }],
        getWritingRegistry: () => registry, flushPendingSave: () => registry.flush(), applyState() {},
        openScene: () => registry.read(ref) })
      controller = new WritingPaneController('pane', { ready() {}, selection() {}, projection() {}, error: error => { throw new Error(error) }, structure() {} })
      controller.registry = registry; controller.references = new Map([['scene', ref]])
      controller.ready({ document, configureWritingTextMapping() {}, setWritingContext() {}, setWritingStructureEnabled() {},
        captureWritingChanges: () => pending.splice(0), writingServiceState: () => null,
        getWritingSelection: () => null, updateWritingScene() {}, acknowledgeWritingScene() {} })
      if (shared) controller.update(registry.getSnapshot(ref))
      releaseCapture = registry.registerCapture(controller.capture)
      root = createRoot(document.getElementById('root'))
      await act(async () => root.render(<><SuggestionsPanel chapterGuid="chapter" sceneId="scene" />{inbox && <InboxPanel />}</>))
    }
    export function html() { return owner?.html ?? registry.getSnapshot(ref).html }
    export function queueHtml(afterHtml) {
      const before = registry.getSnapshot(ref)
      pending.push({ id: crypto.randomUUID(), context, origin: 'typing', kind: 'input',
        changes: [{ ref, beforeHtml: html(), afterHtml, expectedRevision: owner?.revision ?? before.revision }],
        annotationChanges: [], beforeSelection: null, afterSelection: null })
    }
    export async function type(afterHtml) { await act(() => { queueHtml(afterHtml); controller.capture() }) }
    export async function undo() { let result; await act(async () => { result = await getWritingHistory(registry).undo() }); return result }
    export async function redo() { let result; await act(async () => { result = await getWritingHistory(registry).redo() }); return result }
    export async function remotePrefix() {
      await owner.flush(); server.getText('prose').insert(0, 'Peer ')
      await act(() => owner.receive(Y.encodeStateAsUpdate(server)))
    }
    export function changeContext() { return act(() => useProjectStore.setState({ workspaceBusy: true })) }
    export function reloadInbox() { return act(async () => { useEditorBridge.getState().suggestionsChanged() }) }
    export async function cleanExternalCount(mode) {
      let disk = { html: '<p>Clean prose.</p>', hash: 'old' }
      const inactive = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: { read: async () => disk } })
      await inactive.read(ref)
      let counts = new Map()
      const release = observeWritingSuggestionCounts(inactive, 'another-scene', next => { counts = next })
      const initialCount = counts.get(sceneRefKey(ref))
      disk = { html: '<p>Clean <ins data-nl-change="external">new</ins> prose.</p>', hash: 'new' }
      let result
      try {
        if (mode === 'disk') result = await inactive.refreshFromDisk(ref)
        else {
          const before = inactive.getSnapshot(ref)
          const unlock = await inactive.reserveExternal('receipt')
          try { inactive.acceptExternalCommit('receipt', [{ ref, before, afterHtml: disk.html, hash: disk.hash }]) }
          finally { unlock() }
        }
        return { initialCount, count: counts.get(sceneRefKey(ref)), dirty: inactive.isSceneDirty(ref),
          html: inactive.getSnapshot(ref).html, status: result?.status }
      } finally { release(); await inactive.close() }
    }
    export async function cleanSharedCount() {
      let counts = new Map()
      const release = observeWritingSuggestionCounts(registry, 'another-scene', next => { counts = next })
      const initialCount = counts.get(sceneRefKey(ref))
      try {
        const apply = owner.prepareChange(owner.html.replace('after.', '<ins data-nl-change="remote">remote</ins> after.'))
        server.transact(() => apply(server.getText('prose')))
        await act(() => owner.receive(Y.encodeStateAsUpdate(server)))
        return { initialCount, count: counts.get(sceneRefKey(ref)), dirty: owner.dirty }
      } finally { release() }
    }
    export async function loadUnrelatedScenes() {
      await act(async () => { for (let index = 0; index < 1000; index++) await registry.read({ ...ref, sceneId: 'other-' + index }) })
    }
    export async function close() {
      await act(() => root.unmount()); releaseCapture(); controller.dispose()
      await registry.close(); if (owner) await owner.close(); server?.destroy(); host?.dispose()
    }
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'reviewFixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'text' },
  plugins: [{ name: 'review-host', setup(builder) {
    const services = {
      projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({})); export const editorPane = () => ({})`,
      shellStore: `export const useShellStore = { getState: () => ({ activePaneId: 'pane', setActivePane() {} }) }`,
      editorBridgeStore: `import { create } from 'zustand'; export const useEditorBridge = create(set => ({ suggestionsRevision: 0,
        suggestionsChanged: () => set(state => ({ suggestionsRevision: state.suggestionsRevision + 1 })) }))`,
      settingsStore: `export const useSettingsStore = { getState: () => ({ view: null }) }`,
      client: 'export const rpc = window.reviewRpc',
      'react-i18next': 'export const useTranslation = () => ({ t: key => key })',
      sharedProjectNotifications: 'export const useSharedProjectRevision = { subscribe: () => () => {}, getState: () => 0 }',
      writingEditingClaims: 'export const writingEditingClaims = { focus() {}, blur() {} }',
      WritingSharedPresence: 'export class WritingSharedPresence { update() {} close() {} }',
      sharedWritingSessions: `export const findSharedWritingSession = () => window.sharedOwner;
        export const getSharedWritingSession = () => window.sharedOwner;
        export const observeSharedWritingSession = (_, changed) => window.sharedOwner.observe(changed);
        export const createSharedWritingBinding = () => { throw new Error('Unexpected mounting') }`
    }
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in services) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: services[args.path], resolveDir: directory }))
  } }]
})

const initial = '<p>Before <ins data-nl-change="add" data-nl-author="Peer">new</ins> <del data-nl-change="cut">old</del> after.</p>'
async function fixture(t, shared = false, mobile = false, inbox = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, channels = [], calls = []
  w.IS_REACT_ACT_ENVIRONMENT = true; w.structuredClone = structuredClone
  w.novalist = { isMobile: mobile }; w.initialHtml = initial; w.diskHtml = initial; w.sharedWrites = 0
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.reviewRpc = { request: async (method, args) => {
    calls.push(method)
    const root = w.document.createElement('div'); root.innerHTML = w.diskHtml
    if (method === 'inbox/list') return []
    if (method === 'suggestions/inbox') {
      if (w.failInbox) throw new Error('Inbox temporarily unavailable')
      return [{ chapterGuid: 'chapter', chapterTitle: 'Chapter', sceneId: 'scene', sceneTitle: 'Scene',
        count: root.querySelectorAll('ins[data-nl-change],del[data-nl-change]').length }].filter(row => row.count)
    }
    if (method.startsWith('suggestions/') && method !== 'suggestions/forScene') {
      const accept = method.includes('accept')
      for (const mark of root.querySelectorAll('ins[data-nl-change],del[data-nl-change]')) {
        if (args[2] && mark.getAttribute('data-nl-change') !== args[2]) continue
        if (accept === (mark.tagName === 'INS')) mark.replaceWith(...mark.childNodes)
        else mark.remove()
      }
      w.diskHtml = root.innerHTML
    }
    if (method.startsWith('suggestions/')) return [...root.querySelectorAll('ins[data-nl-change],del[data-nl-change]')].map(mark => ({
      id: mark.getAttribute('data-nl-change'), kind: mark.tagName === 'INS' ? 'insertion' : 'deletion', text: mark.textContent, author: '', at: ''
    }))
    if (method === 'project/getState') return {}
    throw new Error('Unexpected RPC: ' + method)
  } }
  w.eval(bundle.outputFiles[0].text)
  const app = w.reviewFixture
  await app.initialize(shared, inbox)
  t.after(async () => { await app.close(); dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  const click = async (label, index = 0) => {
    const buttons = [...w.document.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === label || button.textContent === label)
    assert.ok(buttons[index], 'Missing review action: ' + label)
    await app.act(async () => buttons[index].click())
  }
  return { app, w, calls, click, rows: () => [...w.document.querySelectorAll('.suggestion-text')].map(node => node.textContent) }
}

for (const shared of [false, true]) test(`desktop review lists unsaved canonical suggestions without a disk query (shared=${shared})`, async t => {
  const f = await fixture(t, shared)
  await f.app.type(initial.replace('after.', 'after <ins data-nl-change="unsaved">live</ins>.'))
  assert.deepEqual(f.rows(), ['new', 'old', 'live'])
  assert.deepEqual(f.calls, [])
})

for (const action of ['accept', 'reject']) test(`${action} captures pending prose, updates the retained scene and stays one undoable action`, async t => {
  const f = await fixture(t)
  const dirty = initial.replace('after.', '<b>unsaved</b> after.')
  f.app.queueHtml(dirty)
  await f.click('suggestions.' + action)
  const expected = action === 'accept' ? dirty.replace('<ins data-nl-change="add" data-nl-author="Peer">new</ins>', 'new')
    : dirty.replace('<ins data-nl-change="add" data-nl-author="Peer">new</ins>', '')
  assert.equal(f.app.html(), expected)
  assert.deepEqual(f.calls, [])
  assert.equal((await f.app.undo()).status, 'applied')
  assert.equal(f.app.html(), dirty)
  assert.equal((await f.app.redo()).status, 'applied')
  assert.equal(f.app.html(), expected)
  await f.app.type(expected.replace('after.', 'after. More'))
  assert.ok(!f.app.html().includes('data-nl-change="add"'))
})

test('shared accept-all keeps peer prose through undo and never invokes ordinary scene mutation', async t => {
  const f = await fixture(t, true)
  await f.click('suggestions.acceptAll')
  assert.equal(f.app.html(), '<p>Before new  after.</p>')
  await f.app.remotePrefix()
  assert.equal((await f.app.undo()).status, 'applied')
  assert.equal(f.app.html(), initial.replace('<p>', '<p>Peer '))
  assert.deepEqual(f.calls, [])
  assert.ok(f.w.sharedWrites > 0)
})

for (const [action, expected] of [
  ['accept', '<p>Before new <del data-nl-change="cut">old</del> after.</p>'],
  ['reject', '<p>Before  <del data-nl-change="cut">old</del> after.</p>'],
  ['acceptAll', '<p>Before new  after.</p>'],
  ['rejectAll', '<p>Before  old after.</p>']
]) test(`mobile review retains the existing ${action} RPC path`, async t => {
  const f = await fixture(t, false, true)
  await f.click('suggestions.' + action)
  assert.ok(f.calls.includes('suggestions/' + action))
  assert.equal(f.w.diskHtml, expected)
})

test('reviewing the final suggestion clears the Inbox before autosave and undo restores its row', async t => {
  const f = await fixture(t, false, false, true)
  assert.equal(f.w.document.querySelectorAll('.inbox-suggestion-row').length, 1)
  await f.click('suggestions.acceptAll')
  assert.equal(f.w.diskHtml, initial)
  assert.equal(f.w.document.querySelectorAll('.inbox-suggestion-row').length, 0)
  assert.equal((await f.app.undo()).status, 'applied')
  assert.equal(f.w.document.querySelectorAll('.inbox-suggestion-row').length, 1)
})

test('reject-all preserves ordinary ins/del formatting and clears rows during a workspace transition', async t => {
  const f = await fixture(t)
  const formatted = initial.replace('after.', '<del>struck</del> <ins>ordinary</ins> <b>after.</b>')
  await f.app.type(formatted)
  await f.click('suggestions.rejectAll')
  assert.equal(f.app.html(), formatted.replace('<ins data-nl-change="add" data-nl-author="Peer">new</ins>', '').replace('<del data-nl-change="cut">old</del>', 'old'))
  await f.app.undo()
  assert.equal(f.rows().length, 2)
  await f.app.changeContext()
  assert.deepEqual(f.rows(), [])
})

test('Inbox does not parse newly preloaded clean scenes while observing current edits', async t => {
  const f = await fixture(t, false, false, true)
  const NativeParser = f.w.DOMParser
  let parses = 0
  f.w.DOMParser = class extends NativeParser { parseFromString(...args) { parses++; return super.parseFromString(...args) } }
  await f.app.loadUnrelatedScenes()
  assert.equal(parses, 0)
})

for (const mode of ['disk', 'commit']) test(`Inbox counts a clean inactive scene after external ${mode} changes its canonical revision`, async t => {
  const f = await fixture(t)
  const result = await f.app.cleanExternalCount(mode)
  assert.equal(result.initialCount, undefined)
  assert.equal(result.dirty, false)
  assert.match(result.html, /data-nl-change="external"/)
  if (mode === 'disk') assert.equal(result.status, 'refreshed')
  assert.equal(result.count, 1)
})

test('Inbox observes remote suggestions in an inactive clean shared owner', async t => {
  const f = await fixture(t, true)
  const result = await f.app.cleanSharedCount()
  assert.equal(result.initialCount, undefined)
  assert.equal(result.dirty, false)
  assert.equal(result.count, 3)
})

test('a successful current Inbox reload clears its earlier transient error', async t => {
  const f = await fixture(t, false, false, true)
  f.w.failInbox = true
  await f.app.reloadInbox()
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Inbox temporarily unavailable/)
  f.w.failInbox = false
  await f.app.reloadInbox()
  assert.equal(f.w.document.querySelectorAll('[role="alert"]').length, 0)
  assert.equal(f.w.document.querySelectorAll('.inbox-suggestion-row').length, 1)
})
