import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { EditorFrame, SceneTabStrip } from './src/renderer/src/views/editor/EditorFrame'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { WritingDocumentRegistry } from './src/renderer/src/stores/writingDocuments'
  import { getSharedWritingSession, findSharedWritingSession, closeSharedWritingSessions } from './src/renderer/src/collaboration/sharedWritingSessions'
  import { getSharedWritingAnnotations, closeSharedWritingAnnotations } from './src/renderer/src/collaboration/sharedWritingAnnotations'
  import * as Y from 'yjs'
  export { act }
  export const state = useProjectStore
  export const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  export const reference = sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId })
  const peers = new Map()
  function shared(id) {
    if (!peers.has(id)) {
      const peer = new Y.Doc(), prose = peer.getText('prose')
      prose.insert(0, 'Original')
      prose.insert(8, '\\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
      peers.set(id, peer)
    }
    return { sessionId: 'session', itemId: id, state: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(peers.get(id)))) }
  }
  window.sharedState = id => Y.encodeStateAsUpdate(peers.get(id))
  window.sharedWrite = async (id, update) => {
    if (window.refuseShared) throw new Error('offline')
    Y.applyUpdate(peers.get(id), update)
  }
  export const sharedOwner = id => getSharedWritingSession(shared(id))
  export const findOwner = id => findSharedWritingSession(shared(id))
  export async function remote(id) { await act(async () => {
    peers.get(id).getText('prose').insert(0, 'Remote ')
    sharedOwner(id).receive(Y.encodeStateAsUpdate(peers.get(id)))
  }) }
  export async function sharedEdit(id) { await act(async () => sharedOwner(id).transact(prose => prose.insert(0, 'Local '))) }
  export async function sharedAnnotations(id, comments) { await act(async () => {
    const ref = reference(id)
    getSharedWritingAnnotations(registry).accept(crypto.randomUUID(), [{ registry,
      change: { ref, before: registry.getAnnotations(ref), after: { comments, footnotes: [] } } }])
  }) }
  export async function closeShared() {
    await closeSharedWritingSessions(); await closeSharedWritingAnnotations('project')
    for (const peer of peers.values()) peer.destroy()
  }
  export const registry = new WritingDocumentRegistry({ context, isCurrent: owner => {
    const state = useProjectStore.getState()
    return state.projectPath === owner.workspaceId && state.workspaceEpoch === owner.workspaceEpoch
  }, transport: { read: async ref => ({ html: '<p>Original</p>', hash: 'saved', annotations: { comments: [], footnotes: [] },
      shared: window.sharedIds.includes(ref.sceneId) ? shared(ref.sceneId) : undefined }),
    commit: request => window.commit(request) } })
  window.registry = registry
  let root
  export async function mount() {
    await registry.read(reference('first')); await registry.read(reference('second'))
    await act(async () => { root = createRoot(document.getElementById('host')); root.render(<SceneTabStrip paneId="pane" />) })
  }
  export async function unmount() { await act(async () => root?.unmount()) }
  export async function frame(writing) { await act(async () => root.render(<EditorFrame paneId="pane" writing={writing ? window.writingAdapter : undefined} />)) }
  export async function edit(id, html) {
    await act(async () => {
      const ref = reference(id), before = registry.getSnapshot(ref)
      registry.apply({ id: crypto.randomUUID(), context, origin: 'writer', kind: 'input',
        changes: [{ ref, expectedRevision: before.revision, beforeHtml: before.html, afterHtml: html }],
        annotationChanges: [], beforeSelection: null, afterSelection: null })
    })
  }
  export async function annotate(id, comments) {
    await act(async () => {
      const ref = reference(id)
      registry.apply({ id: crypto.randomUUID(), context, origin: 'writer', kind: 'format', changes: [],
        annotationChanges: [{ ref, before: registry.getAnnotations(ref), after: { comments, footnotes: [] } }],
        beforeSelection: null, afterSelection: null })
    })
  }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'dirtyTabsFixture',
  jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'tab-dependencies', setup(builder) {
    const sources = {
      projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({
        projectPath: 'project', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft', isLoaded: true,
        closingProject: false, workspaceSuspended: false, workspaceBusy: false, dirtyMap: {},
        editors: { pane: { sceneId: 'first', tabs: [{ chapterGuid: 'chapter', sceneId: 'first' },
          { chapterGuid: 'chapter', sceneId: 'second' }] } }, getWritingRegistry: () => window.registry,
        chapters: [{ guid: 'chapter', title: 'Chapter', scenes: [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }] }]
      })); export const editorPane = (state, id) => state.editors[id];`,
      shellStore: `export const useShellStore = () => {};`,
      'react-i18next': `export const useTranslation = () => ({ t: value => value });`,
      MotionPresence: `export const MotionPresence = ({children}) => children;`,
      useEditorMessages: `export const useEditorMessages = () => {};`,
      EditorToolbar: `export const EditorToolbar = () => null;`,
      EntityTypeDialog: `export const EntityTypeDialog = () => null;`,
      AppendToEntityDialog: `export const AppendToEntityDialog = () => null;`,
      InputDialog: `export const InputDialog = () => null;`,
      useEditorFrameModel: `import { useRef } from 'react'; import { useProjectStore } from './projectStore';
        export const useEditorFrameModel = () => ({ iframeRef: useRef(null), pane: 'pane',
          openSceneId: useProjectStore(state => state.editors.pane.sceneId),
          peekScope: {}, peek: {}, formatting: {}, editorFontSize: 17, t: key => key });`,
      useEditorSynchronization: `export const useEditorPersistence = () => {}; export const useEditorScene = () => {}; export const useEditorControls = () => {};`,
      client: `export const rpc = { request: (...args) => window.rpc(...args), onNotification: () => () => {} };`,
      sharedDocuments: `export const decodeState = state => Uint8Array.from(atob(state), value => value.charCodeAt(0));
        export const sharedDocumentConnection = identity => ({ subscribe: () => () => {},
          read: async () => window.sharedState(identity.itemId), write: update => window.sharedWrite(identity.itemId, update) });`
    }
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const name = args.path.split('/').at(-1)
      if (name in sources) return { path: name, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }]
})

function acknowledgement(request) {
  return { status: 'committed', operationId: request.transactionId,
    hashes: [...request.changes, ...request.annotationChanges].map(change => ({ ref: change.ref, hash: request.transactionId })) }
}

async function fixture(t, sharedIds = [], mobile = false) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  const view = dom.window, channels = []
  view.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  view.IS_REACT_ACT_ENVIRONMENT = true
  view.structuredClone = structuredClone
  view.novalist = { isMobile: mobile }
  view.sharedIds = sharedIds
  view.rpc = async (method, [request]) => {
    assert.equal(method, 'writing/commitSharedAnnotations')
    return { status: 'committed', operationId: request.transactionId,
      annotations: request.changes.map(change => ({ ref: change.ref, annotations: change.after })) }
  }
  view.commit = async request => acknowledgement(request)
  view.eval(bundle.outputFiles[0].text)
  const app = view.dirtyTabsFixture
  t.after(async () => {
    await app.unmount()
    view.releaseWrites?.()
    view.commit = async request => acknowledgement(request)
    view.refuseShared = false
    await app.closeShared()
    await app.registry.close()
    view.close()
    for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  })
  await app.mount()
  const dirty = index => !!view.document.querySelectorAll('.editor-tab')[index]?.querySelector('.editor-tab-dirty')
  return { app, view, dirty }
}

for (const writing of [true, false]) test(`${writing ? 'continuous writing' : 'legacy scene'} navigation preserves the iframe and uses the matching transition boundary`, async t => {
  const { app, view } = await fixture(t)
  const animations = []
  view.document.documentElement.dataset.shell = 'desktop'
  view.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  view.HTMLElement.prototype.animate = (...args) => { animations.push(args); return { cancel() {} } }
  view.writingAdapter = {}
  await app.frame(writing)
  assert.equal(view.document.querySelectorAll('.editor-tabs').length, writing ? 0 : 1)
  const frame = view.document.querySelector('iframe')
  const before = animations.length
  await app.act(async () => app.state.setState(state => ({ editors: { ...state.editors,
    pane: { ...state.editors.pane, sceneId: 'second' } } })))
  assert.equal(view.document.querySelector('iframe'), frame)
  assert.equal(view.document.querySelectorAll('.editor-tabs').length, writing ? 0 : 1)
  assert.equal(animations.length - before, writing ? 0 : 1)
})

test('desktop tabs follow canonical prose independently and clear only acknowledged writes', async t => {
  const { app, dirty } = await fixture(t)
  assert.equal(dirty(0), false)
  await app.edit('first', '<p>Changed</p>')
  assert.equal(dirty(0), true)
  assert.equal(dirty(1), false)
  await app.act(async () => app.registry.flush())
  assert.equal(dirty(0), false)
})

test('a late local ACK cannot clear newer prose, and failed publication retains the dirty dot', async t => {
  const { app, view, dirty } = await fixture(t)
  const writes = []
  view.commit = request => new Promise((resolve, reject) => writes.push({ request, resolve, reject }))
  view.releaseWrites = () => writes.forEach(write => write.resolve(acknowledgement(write.request)))
  await app.edit('first', '<p>First change</p>')
  const saving = app.registry.flush()
  await app.edit('first', '<p>Newer change</p>')
  await app.act(async () => writes[0].resolve(acknowledgement(writes[0].request)))
  assert.equal(dirty(0), true)
  const failure = assert.rejects(saving, /offline/)
  await app.act(async () => writes[1].reject(new Error('offline')))
  await failure
  assert.equal(dirty(0), true)
  view.commit = async request => acknowledgement(request)
  await app.act(async () => app.registry.flush())
  assert.equal(dirty(0), false)
})

test('annotation-only saves mark the owning scene and clear after acknowledgement', async t => {
  const { app, dirty } = await fixture(t)
  await app.annotate('second', [{ id: 'comment', text: 'Note', anchorText: '', resolved: false }])
  assert.equal(dirty(0), false)
  assert.equal(dirty(1), true)
  await app.act(async () => app.registry.flush())
  assert.equal(dirty(1), false)
})

test('an unacknowledged local write remains dirty even after undo restores its original HTML', async t => {
  const { app, view, dirty } = await fixture(t)
  view.commit = async () => { throw new Error('acknowledgement lost') }
  await app.edit('first', '<p>Changed</p>')
  await app.act(async () => { await assert.rejects(app.registry.flush(), /lost/) })
  await app.edit('first', '<p>Original</p>')
  assert.equal(dirty(0), true)
  view.commit = async request => acknowledgement(request)
  await app.act(async () => app.registry.flush())
  assert.equal(dirty(0), false)
})

test('shared local edits retain the dot through failed saves; peer edits and clean acknowledgement do not', async t => {
  const { app, view, dirty } = await fixture(t, ['first'])
  const owner = app.sharedOwner('first')
  await app.remote('first')
  assert.equal(dirty(0), false, 'received peer text is not an unsaved local edit')
  view.refuseShared = true
  await app.sharedEdit('first')
  await app.act(async () => { await assert.rejects(owner.flush(), /waiting to be saved/) })
  assert.equal(dirty(0), true)
  assert.equal(dirty(1), false)
  view.refuseShared = false
  await app.act(async () => owner.flush())
  assert.equal(dirty(0), false)
})

test('shared annotation-only dirty state is per scene and survives an older acknowledgement', async t => {
  const { app, view, dirty } = await fixture(t, ['first', 'second'])
  const writes = []
  const acknowledged = request => ({ status: 'committed', operationId: request.transactionId,
    annotations: request.changes.map(change => ({ ref: change.ref, annotations: change.after })) })
  view.rpc = (_method, [request]) => new Promise(resolve => writes.push({ request, resolve }))
  view.releaseWrites = () => {
    view.rpc = async (_method, [request]) => acknowledged(request)
    writes.forEach(write => write.resolve(acknowledged(write.request)))
  }
  const comment = { id: 'comment', text: 'First', anchorText: '', resolved: false }
  await app.sharedAnnotations('first', [comment])
  assert.equal(dirty(0), true)
  assert.equal(dirty(1), false)
  await app.sharedAnnotations('first', [{ ...comment, text: 'Newer' }])
  await app.act(async () => writes[0].resolve(acknowledged(writes[0].request)))
  assert.equal(dirty(0), true)
  await app.act(async () => writes[1].resolve(acknowledged(writes[1].request)))
  assert.equal(dirty(0), false)
})

test('closing observed tabs releases clean shared owners and stale identities cannot mark another book', async t => {
  const { app, dirty } = await fixture(t, ['first'])
  const owner = app.sharedOwner('first')
  assert.equal(owner.releaseUnused(), false)
  await app.act(async () => app.state.setState({ activeBookId: 'other', getWritingRegistry: () => null }))
  assert.equal(owner.isClosed, true)
  assert.equal(app.findOwner('first'), undefined)
  assert.equal(dirty(0), false)
  await app.edit('second', '<p>Old book edit</p>')
  assert.equal(dirty(1), false)
})

test('mobile tabs keep their legacy per-scene dirty map without observing desktop documents', async t => {
  const { app, dirty } = await fixture(t, [], true)
  await app.edit('first', '<p>Canonical desktop-only change</p>')
  assert.equal(dirty(0), false)
  await app.act(async () => app.state.setState({ dirtyMap: { second: true } }))
  assert.equal(dirty(1), true)
})
