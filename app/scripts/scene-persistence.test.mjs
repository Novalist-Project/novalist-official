import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'
import * as pendingWrites from '../src/renderer/src/stores/pendingWrites.ts'

const writingDocuments = loadRendererSource('src/stores/writingDocuments.ts', {
  './pendingWrites': pendingWrites
}, { crypto, structuredClone })
const writingPanePersistence = loadRendererSource('src/stores/writingPanePersistence.ts', {
  './writingDocuments': writingDocuments, '../collaboration/sharedWritingSessions': { findSharedWritingSession: () => undefined },
  '../collaboration/sharedWritingAnnotations': { getSharedWritingAnnotations: () => assert.fail('No shared annotations in this fixture') }
})
const { WritingEditingClaims } = loadRendererSource('src/stores/writingEditingClaims.ts', {
  './writingDocuments': writingDocuments, '../collaboration/sharedWritingSessions': {}, '../collaboration/sharedWritingAnnotations': {}
})

const turn = () => new Promise((resolve) => setImmediate(resolve))
const editor = (html, hash = 'hash-0') => ({ chapterGuid: 'c', sceneId: 's', html, plainText: html, hash, isDirty: true, tabs: [{ chapterGuid: 'c', sceneId: 's' }] })

function fixture(isMobile = false) {
  const editingClaims = { writingEditingClaims: new WritingEditingClaims() }
  let state = { projectPath: '/synthetic/project', activeBookId: 'book', activeDraftId: 'draft', drafts: [], workspaceEpoch: 1, sceneHashes: { s: 'hash-0' }, sceneConflict: null, activeEditorPaneId: 'a', editors: {}, dirtyMap: {}, chapters: [] }
  const store = { getState: () => state, setState: (next) => { state = { ...state, ...(typeof next === 'function' ? next(state) : next) } } }
  const helpers = { useProjectStore: store, mirror: () => ({}),
    mapEditors: (editors, fn) => Object.fromEntries(Object.entries(editors).map(([id, value]) => [id, fn(value)])),
    editorPane: (s, pane) => s.editors[pane] ?? { tabs: [] },
    patchEditor: (s, pane, patch) => ({ editors: { ...s.editors, [pane]: { ...s.editors[pane], ...patch } } }),
    targetEditorPane: () => 'a', writePaneIds: () => ['a', 'b'], EMPTY_EDITOR: { tabs: [] } }
  let disk = 'base', hash = 'hash-0', serial = 0
  const requests = []
  const rpc = { request: async (method, args) => {
    requests.push({ method, args })
    if (method === 'scenes/write') {
      if (args[4] !== hash) return { conflicted: true, diskHtml: disk, hash }
      disk = args[2]; hash = `hash-${++serial}`
      return { conflicted: false, hash, wordCount: 1 }
    }
    if (method === 'scenes/read') return { html: 'next', hash: 'next-hash' }
    throw new Error(method)
  } }
  const background = loadRendererSource('src/rpc/backgroundReads.ts', {}, { window: { novalist: { isMobile } } })
  const queue = loadRendererSource('src/stores/sceneWriteQueue.ts', { '../rpc/backgroundReads': background })
  const timers = []
  const persistence = loadRendererSource('src/stores/projectPersistence.ts', {
    './writingEditingClaims': editingClaims,
    '../rpc/client': { rpc }, './projectStore': helpers, './sceneWriteQueue': queue,
    '../collaboration/sharedEditors': { flushSharedEditor() { throw new Error('This fixture only opens local scenes') } }
  }, { setTimeout: (fn) => (timers.push(fn), timers.length), clearTimeout() {} })
  const shell = { unsavedGuards: {}, setPaneView() {}, setActivePane() {}, panes: {}, mobileTab: 'dashboard', setMobileTab(tab) { this.mobileTab = tab } }
  const storage = new Map()
  const journal = loadRendererSource('src/mobile/recoveryJournal.ts', {}, { localStorage: {
    getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key)
  } })
  const recovery = loadRendererSource('src/mobile/recovery.ts', {
    '../i18n': { default: { t: (key) => key } }, '../rpc/client': { rpc },
    '../stores/projectStore': { useProjectStore: store },
    '../stores/manuscriptStore': { pendingManuscriptRecovery: () => [], hasPendingManuscriptWrites: () => false },
    '../stores/hostBridgeStore': { useHostBridgeStore: { getState: () => ({ pushToast: (message) => { throw new Error(message) } }) } },
    './recoveryJournal': journal
  }, { window: { novalist: { isMobile } } })
  const actions = loadRendererSource('src/stores/projectEditorActions.ts', {
    '../rpc/client': { rpc }, './shellStore': { useShellStore: { getState: () => shell }, paneLeaves: () => [] },
    './projectStore': helpers, './projectPersistence': persistence, './sceneWriteQueue': queue,
    './pendingWrites': { capturePendingWrites() {} }, './projectSceneActions': { runSceneContext: (fn) => fn() },
    '../mobile/recovery': recovery, '../rpc/backgroundReads': background,
    './writingDocuments': writingDocuments,
    './writingSavedCounts': { writingSavedCounts: () => ({}) },
    './writingPanePersistence': writingPanePersistence,
    './writingEditingClaims': editingClaims,
    './writingPersistence': { scheduleWritingSave() {} },
    './writingSceneNavigation': { widenWritingRunForScene: async () => {}, revealWritingSceneInPane: async () => {} }
  }, { window: { novalist: { isMobile } } }).createProjectEditorActions(store.setState, store.getState)
  store.setState(actions)
  return { store, shell, rpc, persistence, timers, requests, background, queue, disk: () => disk, readJournal: journal.readRecoveryJournal }
}

test('writing registry store action captures one immutable context for all projections', async () => {
  const f = fixture()
  const owner = f.store.getState().getWritingRegistry()
  assert.equal(owner, f.store.getState().getWritingRegistry())
  assert.equal(owner.context.workspaceEpoch, 1)
  assert.equal(owner.context.workspaceId, '/synthetic/project')
  f.store.setState({ workspaceEpoch: 2, activeDraftId: 'next-draft' })
  await assert.rejects(owner.read({ bookId: 'book', draftId: 'draft', chapterGuid: 'c', sceneId: 's' }), /context/)
  const next = f.store.getState().getWritingRegistry()
  assert.notEqual(next, owner)
  assert.equal(next.context.draftId, 'next-draft')
  await owner.close()
  await next.close()
})

test('mobile navigation and saves cancel background scans before queuing file requests', async () => {
  const f = fixture(true)
  const reading = new AbortController()
  f.background.registerBackgroundRead(reading)
  await f.store.getState().openSceneIn('a', 'c', 'next')
  assert.equal(reading.signal.aborted, true)
  const writing = new AbortController()
  f.background.registerBackgroundRead(writing)
  await f.queue.enqueueSceneWrite('next', async () => assert.equal(writing.signal.aborted, true))
})

test('desktop navigation reads retained canonical prose and preserves pane scope without activation', async () => {
  const f = fixture()
  const context = { workspaceId: '/synthetic/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const refs = []
  const owner = new writingDocuments.WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
    read: async ref => { refs.push(ref); return { html: 'Canonical', hash: 'canonical' } },
    activate: async () => { throw new Error('Passive navigation cannot activate a scene') },
    commit: async () => { throw new Error('No prose changed') }
  } })
  f.store.setState({ getWritingRegistry: () => owner,
    chapters: [{ guid: 'c', scenes: [{ id: 'next' }] }],
    editors: { a: { ...editor('base'), isDirty: false, writingScope: 'chapter' } } })
  await f.store.getState().openSceneIn('a', 'c', 'next')
  assert.equal(f.store.getState().editors.a.html, 'Canonical')
  assert.equal(f.store.getState().editors.a.writingScope, 'chapter')
  assert.equal(refs.length, 1)
  assert.equal(refs[0].draftId, 'draft')
  assert.equal(f.requests.length, 0)
  await f.store.getState().openSceneIn('a', 'c', 'missing')
  assert.equal(refs.length, 1)
  assert.equal(f.store.getState().editors.a.sceneId, 'next')
  await owner.close()
})

for (const scope of ['scene', 'chapter', 'manuscript']) {
  test(`unified ${scope} navigation changes the scene without accumulating legacy tabs`, async () => {
    const f = fixture()
    const context = { workspaceId: '/synthetic/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
    const owner = new writingDocuments.WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
      read: async ref => ({ html: ref.sceneId, hash: ref.sceneId }),
      activate: async () => { throw Error('Navigation must remain passive') },
      commit: async () => { throw Error('Navigation must not write prose') }
    } })
    f.store.setState({ getWritingRegistry: () => owner, chapters: [{ guid: 'c', scenes: ['one', 'two', 'three'].map(id => ({ id })) }],
      editors: { a: { ...editor('<p>Old</p>'), isDirty: false, writingScope: scope } } })
    for (const sceneId of ['one', 'two', 'three', 'one']) {
      await f.store.getState().openSceneIn('a', 'c', sceneId)
      const pane = f.store.getState().editors.a
      assert.equal(pane.sceneId, sceneId)
      assert.equal(pane.html, sceneId)
      assert.equal(pane.writingScope, scope)
      assert.equal(pane.tabs.length, 0)
    }
    assert.equal(f.requests.length, 0)
    await owner.close()
  })
}

test('mobile scene navigation retains its existing scene tabs', async () => {
  const f = fixture(true)
  for (const sceneId of ['one', 'two', 'one']) await f.store.getState().openSceneIn('a', 'c', sceneId)
  assert.deepEqual(Array.from(f.store.getState().editors.a.tabs, tab => tab.sceneId), ['one', 'two'])
})

test('opening a scene from the phone dashboard switches to the writing tab', async () => {
  const f = fixture(true)
  await f.store.getState().openSceneIn('a', 'c', 'next')
  assert.equal(f.shell.mobileTab, 'manuscript')
  assert.equal(f.store.getState().editors.a.sceneId, 'next')
})

test('mobile scene edits survive in the journal before autosave or a failure notification', () => {
  const f = fixture(true)
  f.store.setState({ editors: { a: editor('base'), b: { ...editor('second'), sceneId: 'other' } } })
  f.store.getState().onEditorContentChanged('a', '<p>First pending edit</p>', 'First pending edit')
  f.store.getState().onEditorContentChanged('b', '<p>Second pending edit</p>', 'Second pending edit')
  f.store.getState().onEditorContentChanged('a', '<p>Newest pending edit</p>', 'Newest pending edit')
  const entries = f.readJournal()
  assert.equal(entries.length, 2)
  assert.equal(entries.find((entry) => entry.source === 'pane:a').html, '<p>Newest pending edit</p>')
  assert.equal(entries.find((entry) => entry.source === 'pane:b').sceneId, 'other')
  assert.equal(entries[0].scope.draftId, 'draft')
  assert.equal(entries[0].hash, 'hash-0')
  assert.equal(f.requests.length, 0)
  assert.equal(f.disk(), 'base')
})

test('desktop scene edits do not create a mobile recovery journal', () => {
  const f = fixture()
  f.store.setState({ editors: { a: editor('base') } })
  f.store.getState().onEditorContentChanged('a', 'desktop edit', 'desktop edit')
  assert.equal(f.readJournal().length, 0)
})

test('divergent split panes retain their own base and produce a conflict', async () => {
  const f = fixture()
  f.store.setState({ editors: { a: editor('first'), b: editor('second') } })
  await f.persistence.flushEditor(f.store.getState().editors.a)
  await f.persistence.flushEditor(f.store.getState().editors.b)
  assert.equal(f.disk(), 'first')
  assert.equal(f.store.getState().sceneConflict.mine, 'second')
  assert.equal(f.store.getState().editors.b.isDirty, true)
})

for (const operation of ['open', 'close']) test(`refused mobile save preserves the visible dirty editor on ${operation}`, async () => {
  const f = fixture(true)
  f.store.setState({ editors: { a: editor('mine', 'stale') } })
  if (operation === 'open') await f.store.getState().openSceneIn('a', 'c', 'next')
  else await f.store.getState().closeTab('a', 's')
  f.store.getState().dismissSceneConflict()
  assert.equal(f.store.getState().editors.a.sceneId, 's')
  assert.equal(f.store.getState().editors.a.html, 'mine')
  assert.equal(f.store.getState().editors.a.isDirty, true)
})

test('overlapping autosaves serialize and preserve a newer dirty edit until acknowledged', async () => {
  const f = fixture()
  const request = f.rpc.request
  const releases = []
  f.rpc.request = (method, args) => method === 'scenes/write' ? new Promise((resolve) => { releases.push(() => request(method, args).then(resolve)) }) : request(method, args)
  f.store.setState({ editors: { a: editor('one') } })
  f.persistence.scheduleSave('a', 'c', 's', 'one', 'one')
  f.timers.shift()()
  await turn()
  f.store.setState({ editors: { a: editor('two') } })
  f.persistence.scheduleSave('a', 'c', 's', 'two', 'two')
  f.timers.shift()()
  await turn()
  assert.equal(releases.length, 1)
  await releases.shift()()
  await turn()
  assert.equal(f.store.getState().editors.a.html, 'two')
  assert.equal(f.store.getState().editors.a.isDirty, true)
  await releases.shift()()
  await f.persistence.autosaveWrites.get('a')
  assert.equal(f.disk(), 'two')
  assert.equal(f.store.getState().sceneConflict, null)
  assert.equal(f.store.getState().editors.a.isDirty, false)
})

test('a failed mobile save retains the dirty buffer and the next explicit flush can retry', async () => {
  const f = fixture(true)
  const request = f.rpc.request
  f.store.setState({ editors: { a: editor('mine') } })
  f.rpc.request = async () => { throw new Error('offline') }
  await assert.rejects(f.store.getState().flushPane('a'), /offline/)
  assert.equal(f.store.getState().editors.a.isDirty, true)
  f.rpc.request = request
  await f.store.getState().flushPane('a')
  assert.equal(f.disk(), 'mine')
})

for (const action of ['flush', 'close', 'move']) test(`desktop ${action} drains canonical prose and preserves tabs on a refused write`, async () => {
  const f = fixture()
  const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'c', sceneId: 's' }
  let refuse = true, disk = 'base', reads = 0, commits = 0
  const owner = new writingDocuments.WritingDocumentRegistry({
    context: { workspaceId: '/synthetic/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }, isCurrent: () => true,
    transport: { read: async () => { reads++; return { html: disk, hash: disk === 'base' ? 'base-hash' : 'changed-hash' } },
      activate: async () => true, commit: async request => {
        commits++
        if (refuse) return { status: 'conflict', conflicts: [{ ref, hash: 'changed-hash' }] }
        disk = request.changes[0].afterHtml
        return { status: 'committed', operationId: request.transactionId, hashes: [{ ref, hash: 'saved-hash' }] }
      } }
  })
  await owner.read(ref)
  owner.apply({ id: crypto.randomUUID(), context: owner.context, origin: 'writer', kind: 'input',
    changes: [{ ref, expectedRevision: 0, beforeHtml: 'base', afterHtml: 'canonical pending' }],
    annotationChanges: [], beforeSelection: null, afterSelection: null })
  f.store.setState({ getWritingRegistry: () => owner,
    editors: { a: { ...editor('stale pane mirror'), isDirty: false }, b: { ...editor('destination'), sceneId: 'other', isDirty: false } } })
  disk = 'external edit'
  const before = f.store.getState().editors
  const invoke = () => action === 'flush' ? f.store.getState().flushPane('a')
    : action === 'close' ? f.store.getState().closeTab('a', 's') : f.store.getState().moveTabToOtherPane('a', 's')
  await assert.rejects(invoke(), /writing.conflict/)
  assert.equal(f.store.getState().editors, before)
  assert.equal(owner.isDirty, true)
  assert.equal(owner.getSnapshot(ref).html, 'canonical pending')
  assert.equal(f.store.getState().sceneConflict.mine, 'canonical pending')
  assert.equal(f.store.getState().sceneConflict.theirs, 'external edit')
  assert.equal(f.store.getState().sceneConflict.writing.context, owner.context)
  assert.equal(commits, 1); assert.equal(reads, 2)
  assert.equal(f.requests.length, 0, 'desktop cannot write the legacy pane mirror')
  refuse = false
  await f.store.getState().flushPane('a')
  assert.equal(disk, 'canonical pending')
  assert.equal(owner.isDirty, false)
  await owner.close()
})

for (const target of ['s', 'next']) test(`desktop scene navigation to ${target} retains failed pending edits without a save barrier`, async () => {
  const f = fixture()
  const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'c', sceneId: 's' }
  let refuse = true, commits = 0
  const owner = new writingDocuments.WritingDocumentRegistry({
    context: { workspaceId: '/synthetic/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }, isCurrent: () => true,
    transport: { read: async () => ({ html: 'base', hash: 'base' }), activate: async () => true,
      commit: async request => {
        commits++
        if (refuse) throw new Error('offline')
        return { status: 'committed', operationId: request.transactionId, hashes: [{ ref, hash: 'saved' }] }
      } }
  })
  await owner.read(ref)
  owner.apply({ id: crypto.randomUUID(), context: owner.context, origin: 'writer', kind: 'input',
    changes: [{ ref, expectedRevision: 0, beforeHtml: 'base', afterHtml: 'retained pending' }],
    annotationChanges: [], beforeSelection: null, afterSelection: null })
  await assert.rejects(owner.flush(), /offline/)
  f.store.setState({ getWritingRegistry: () => owner, chapters: [{ guid: 'c', scenes: [{ id: 's' }, { id: 'next' }] }],
    editors: { a: { ...editor('stale mirror'), isDirty: false } } })
  await f.store.getState().openSceneIn('a', 'c', target)
  assert.equal(f.store.getState().editors.a.sceneId, target)
  assert.equal(f.store.getState().editors.a.html, target === 's' ? 'retained pending' : 'base')
  assert.equal(owner.getSnapshot(ref).html, 'retained pending')
  assert.equal(owner.isDirty, true)
  assert.equal(commits, 1)
  refuse = false; await owner.close()
})
