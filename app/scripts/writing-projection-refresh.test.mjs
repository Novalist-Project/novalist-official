import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: { resolveDir: directory, loader: 'tsx', contents: `
    import React, { act, useEffect } from 'react'
    import { createRoot } from 'react-dom/client'
    import { useUnifiedWritingDocument } from './src/renderer/src/views/editor/useUnifiedWritingDocument'
    import { useWritingChromeTargets } from './src/renderer/src/views/editor/useWritingCanvas'
    import { useProjectStore } from './src/renderer/src/stores/projectStore'
    import { useSharedProjectRevision } from './src/renderer/src/collaboration/sharedProjectNotifications'
    import { useFilterStore } from './src/renderer/src/stores/filterStore'
    import { registerPendingWrite } from './src/renderer/src/stores/pendingWrites'
    import { SharedSceneSession } from './src/renderer/src/collaboration/SharedSceneSession'
    import * as Y from 'yjs'
    let root, latest
    const servers = new Map(), refused = new Set()
    window.sharedOwners = new Map()
    export function shared(id) {
      const server = new Y.Doc(), prose = server.getText('prose')
      prose.insert(0, 'Base')
      prose.insert(4, '\\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
      servers.set(id, server); refused.add(id)
      const owner = new SharedSceneSession({ document, toDisplayImages() {}, sanitizeSceneFragment(html) {
        const template = document.createElement('template'); template.innerHTML = html; return template.content
      } }, Y.encodeStateAsUpdate(server), { subscribe: () => () => {}, read: async () => Y.encodeStateAsUpdate(server),
        write: async update => { if (refused.has(id)) throw new Error('Shared write unavailable'); Y.applyUpdate(server, update) } })
      window.sharedOwners.set(id, owner)
      return owner
    }
    export async function failShared(id) {
      await act(async () => {
        const owner = window.sharedOwners.get(id)
        refused.add(id)
        owner.transact(prose => prose.insert(4, ' local'))
        await owner.flush()
      })
    }
    export async function acknowledgeShared(id) { await act(async () => { refused.delete(id); await window.sharedOwners.get(id).flush() }) }
    export function allowShared(id) { refused.delete(id) }
    export const savedShared = id => servers.get(id).getText('prose').toString()
    export async function closeShared() {
      refused.clear()
      for (const owner of window.sharedOwners.values()) await owner.close()
      for (const server of servers.values()) server.destroy()
    }
    function Probe() {
      latest = useUnifiedWritingDocument('pane', () => {})
      useEffect(() => latest.adapter.callbacks.ready(window), [])
      const chrome = useWritingChromeTargets(latest.live, latest.snapshots, latest.chapters,
        latest.scope, latest.anchor?.chapterGuid, latest.projectionRevision, true)
      window.chromeTargets = chrome
      return null
    }
    export async function mount() { root = createRoot(document.getElementById('host')); await act(async () => root.render(<Probe />)) }
    export async function unmount() { await act(() => root.unmount()) }
    export async function refresh() { await act(async () => {
      useProjectStore.setState(state => ({ chapters: state.chapters.map(chapter => ({ ...chapter,
        title: 'Updated heading', scenes: chapter.scenes.map(scene => ({ ...scene, wordCount: scene.wordCount + 1 })) })) }))
      useSharedProjectRevision.setState(value => value + 1)
    }) }
    export async function filter() { await act(async () => useFilterStore.setState(state => ({ filter: { ...state.filter, stage: 'draft' } }))) }
    export const state = () => latest
    export async function scope(value) { await act(async () => latest.setScope(value)) }
    export const pending = registerPendingWrite
    export async function retry() { await act(async () => latest.retry()) }
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'projectionFixture',
  jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'projection-dependencies', setup(builder) {
    const sources = {
      projectStore: `import { create } from 'zustand';
        export const useProjectStore = create(() => ({ workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft',
          editors: { pane: { chapterGuid: 'chapter', sceneId: 'first' } }, getWritingRegistry: () => window.registry,
          chapters: [{ guid: 'chapter', order: 0, title: 'Chapter', status: '', scenes: [
            { id: 'first', order: 0, stage: 'draft', plotlineIds: [], wordCount: 2 },
            { id: 'second', order: 1, stage: 'done', plotlineIds: [], wordCount: 2 }] },
            { guid: 'empty', order: 1, title: 'Empty', status: '', scenes: [] }] }));
        export const editorPane = (state, id) => state.editors[id]; export const useBookScope = () => 'book';`,
      shellStore: `import { create } from 'zustand'; export const findPane = panes => panes;
        export const useShellStore = create(set => ({ panes: { kind: 'leaf', writingScope: 'manuscript' },
          setPaneWritingScope: (id, writingScope) => set({ panes: { kind: 'leaf', writingScope } }) }));`,
      filterStore: `import { create } from 'zustand'; export const useFilterStore = create(() => ({ filter: {
        status: '', character: '', location: '', plotline: '', stage: '' } }));`,
      manuscriptStore: `export const useManuscriptStore = selector => selector({ composed: null });`,
      sharedProjectNotifications: `import { create } from 'zustand'; export const useSharedProjectRevision = create(() => 0);`,
      writingPersistence: `export const observeWritingPersistence = () => () => {};`,
      sharedWritingSessions: `export const findSharedWritingSession = identity => window.sharedOwners.get(identity.itemId);`,
      writingPaneController: `export class WritingPaneController {
        constructor(id, callbacks) { this.callbacks = callbacks }
        capture = () => {}; startServices = () => {}; dispose = () => {}; update = () => {}; restoreScopePosition = () => {};
        retainScopePosition() { window.scopeRetentions++; return { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'second' } }
        project() { window.projectionCalls++ }
      }`,
      client: `export const rpc = { request: async () => { window.entityReads++; return [] } };`
    }
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }]
})

async function fixture(t, sharedIds = []) {
  const dom = new JSDOM('<div id="host"></div><div id="editor"><section data-writing-scene="first"></section><section data-writing-scene="second"></section></div>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  const view = dom.window
  const channels = []
  view.MessageChannel = class extends MessageChannel {
    constructor() { super(); channels.push(this) }
  }
  view.IS_REACT_ACT_ENVIRONMENT = true
  view.projectionCalls = 0
  view.scopeRetentions = 0
  view.entityReads = 0
  const reads = []
  view.registry = {
    context: { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' },
    read: async ref => { reads.push(ref.sceneId); return { ...ref, html: '<p>Two words</p>', hash: '', revision: 0,
      shared: sharedIds.includes(ref.sceneId) ? { sessionId: 'recovered', itemId: ref.sceneId, state: '' } : null } },
    subscribe: () => () => {}, registerCapture: () => () => {}, flush: async () => {}
  }
  view.getWritingSceneRoot = id => view.document.querySelector(`[data-writing-scene="${id}"]`)
  view.eval(bundle.outputFiles[0].text)
  const app = view.projectionFixture
  t.after(async () => {
    await app.unmount(); await app.closeShared(); view.close()
    for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  })
  for (const id of sharedIds) {
    app.shared(id)
    await assert.rejects(app.failShared(id), /waiting to be saved/)
  }
  await app.mount()
  return { app, view, reads }
}

test('metadata refresh keeps the same prose projection and chrome; changed filters still update it', async t => {
  const { app, view, reads } = await fixture(t)
  assert.deepEqual(reads, ['first', 'second'])
  const firstChrome = view.chromeTargets.targets[0].element
  const emptyChrome = view.chromeTargets.emptyTargets[0].element
  const projects = view.projectionCalls
  for (let i = 0; i < 5; i++) await app.refresh()
  assert.deepEqual(reads, ['first', 'second'], 'metadata must not reload every scene')
  assert.equal(view.projectionCalls, projects, 'metadata must not reproject unchanged prose')
  assert.equal(view.chromeTargets.targets[0].element, firstChrome, 'scene chrome stays mounted')
  assert.equal(view.chromeTargets.emptyTargets[0].element, emptyChrome, 'empty chapter chrome stays mounted')
  assert.equal(view.chromeTargets.emptyTargets[0].chapter.title, 'Updated heading')
  assert.equal(view.entityReads, 0)
  await app.filter()
  assert.deepEqual(Array.from(app.state().refs, ref => ref.sceneId), ['first'])
  assert.equal(view.projectionCalls, projects + 1)
})

test('choosing the current scope creates no stale position; a changed scope adopts the live scene', async t => {
  const { app, view } = await fixture(t)
  await app.scope('manuscript')
  assert.equal(view.scopeRetentions, 0)
  await app.scope('scene')
  assert.equal(view.scopeRetentions, 1)
  assert.equal(app.state().anchor.sceneId, 'second')
  assert.deepEqual(Array.from(app.state().refs, ref => ref.sceneId), ['second'])
})

test('Retry awaits retained shared writes, keeps failures visible, and clears the error only after acknowledgement', async t => {
  const { app } = await fixture(t)
  let attempts = 0, reject = true
  const release = app.pending(async () => {
    attempts++
    if (reject) throw new Error('Shared write unavailable')
  })
  t.after(release)
  await app.retry()
  assert.equal(attempts, 1)
  assert.match(app.state().error, /Shared write unavailable/)
  reject = false
  await app.retry()
  assert.equal(attempts, 2)
  assert.equal(app.state().error, null)
})

test('mounting a retained failed shared owner exposes Retry through projection refresh until its write is acknowledged', async t => {
  const { app, view } = await fixture(t, ['first'])
  const owner = view.sharedOwners.get('first')
  assert.equal(owner.dirty, true)
  assert.match(app.state().error ?? '', /Shared edits are still waiting to be saved/)
  await app.refresh(); await app.filter()
  assert.match(app.state().error ?? '', /Shared edits are still waiting to be saved/)
  await app.retry()
  assert.equal(owner.dirty, true)
  assert.match(app.state().error ?? '', /Shared edits are still waiting to be saved/)
  app.allowShared('first'); await app.retry()
  assert.equal(owner.dirty, false)
  assert.equal(app.state().error, null)
  assert.equal(app.savedShared('first'), 'Base local\n')
})

test('acknowledging one shared owner cannot hide another retained failure; the final acknowledgement clears it', async t => {
  const { app } = await fixture(t, ['first', 'second'])
  assert.match(app.state().error ?? '', /waiting to be saved/)
  await app.acknowledgeShared('first')
  assert.match(app.state().error ?? '', /waiting to be saved/)
  await app.acknowledgeShared('second')
  assert.equal(app.state().error, null)
})

test('failed manual Retry then later owner acknowledgement clears the error', async t => {
  const { app, view } = await fixture(t, ['first'])
  await app.retry()
  assert.equal(view.sharedOwners.get('first').dirty, true)
  await app.acknowledgeShared('first')
  assert.equal(view.sharedOwners.get('first').dirty, false)
  assert.equal(app.state().error, null)
})

test('a shared acknowledgement preserves an unrelated pending-write error even with identical message text', async t => {
  const { app, view } = await fixture(t, ['first'])
  const unrelated = new Error(view.sharedOwners.get('first').error.message)
  await app.acknowledgeShared('first')
  const release = app.pending(async () => { throw unrelated })
  t.after(release)
  await app.retry()
  assert.equal(app.state().error, String(unrelated))
  await assert.rejects(app.failShared('first'), /waiting to be saved/)
  await app.acknowledgeShared('first')
  assert.equal(view.sharedOwners.get('first').dirty, false)
  assert.equal(app.state().error, String(unrelated))
})
