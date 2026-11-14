import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  projectStore: `import { create } from 'zustand'; export const editorPane = (state, pane) => state.editors[pane] ?? {};
    export const useProjectStore = create(() => ({ isLoaded: true, projectPath: 'project', workspaceEpoch: 1,
      activeBookId: 'book', activeDraftId: 'draft', openChapterGuid: 'chapter', openSceneId: 'scene',
      activeEditorPaneId: 'pane', editors: {}, getWritingRegistry: () => window.registry }));`,
  shellStore: `import { create } from 'zustand'; export const useShellStore = create(set => ({
    activePaneId: 'pane', inspectorTab: 'context', pendingFootnoteText: null,
    requestFootnoteText: id => set({ inspectorTab: 'footnotes', pendingFootnoteText: id }),
    clearPendingFootnoteText: () => set({ pendingFootnoteText: null }) }));`,
  settingsStore: `export const useSettingsStore = { getState: () => ({ view: null }) };`,
  writingHistory: `import { acceptWritingTransaction as accept, acceptSharedWritingTransaction, getWritingHistory }
      from './src/renderer/src/stores/writingHistory.ts';
    export { acceptSharedWritingTransaction, getWritingHistory };
    export const acceptWritingTransaction = (registry, transaction) => { accept(registry, transaction); window.transactions.push(transaction); };`,
  writingPersistence: `export const scheduleWritingSave = () => {}; export const reserveWritingBatch = () => {};`,
  writingEditingClaims: `export const writingEditingClaims = { focus() {}, blur() {} };`,
  WritingSharedPresence: `export class WritingSharedPresence { update() {} close() {} }`,
  sharedWritingSessions: `export const createSharedWritingBinding = () => {}; export const getSharedWritingSession = () => {};`,
  SharedWritingHistory: `export class SharedWritingHistory {}`,
  sharedWritingAnnotations: `export const getSharedWritingAnnotations = () => {}; export const refreshSharedWritingAnnotations = () => {};`,
  sharedProjectNotifications: `export const useSharedProjectRevision = {};`,
  pendingWrites: `export const registerPendingWrite = () => () => {};`,
  writingError: `export const writingErrorMessage = value => value;`,
  'react-i18next': `export const useTranslation = () => ({ t: key => key });`,
  'lucide-react': `export const X = () => null;`,
  client: `export const rpc = { request: (...args) => window.request(...args) };`
}
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { AnnotationsPanel } from './src/renderer/src/shell/AnnotationsPanel'
  import { WritingDocumentRegistry } from './src/renderer/src/stores/writingDocuments'
  import { WritingPaneController } from './src/renderer/src/views/editor/writingPaneController'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { useShellStore } from './src/renderer/src/stores/shellStore'
  import { useEditorBridge } from './src/renderer/src/stores/editorBridgeStore'
  import { getWritingHistory } from './src/renderer/src/stores/writingHistory'
  const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
  const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const selection = { anchor: { sceneId: 'scene', offset: 0 }, focus: { sceneId: 'scene', offset: 0 } }
  let root, controller
  function Panel() {
    const tab = useShellStore(state => state.inspectorTab)
    const scene = useProjectStore(state => state.openSceneId)
    return tab === 'footnotes' ? <AnnotationsPanel chapterGuid="chapter" sceneId={scene} /> : null
  }
  export async function start(initial = { html: '<p>Text</p>', annotations: { comments: [], footnotes: [] } }) {
    window.transactions = []
    window.registry = new WritingDocumentRegistry({ context, isCurrent: () => true,
      transport: { read: async () => ({ ...initial, hash: 'hash' }) } })
    await window.registry.read(ref)
    controller = new WritingPaneController('pane', { ready() {}, selection() {}, projection() {}, error(error) { throw Error(error) }, structure() {} })
    controller.registry = window.registry
    controller.references.set('scene', ref)
    const prose = document.createElement('section')
    window.registry.subscribe(ref, snapshot => { prose.innerHTML = snapshot.html })
    const removeMarker = (id, kind) => {
      window.removed.push(id)
      for (const marker of prose.querySelectorAll(kind === 'footnote' ? '[data-fn-id]' : '[data-comment-id]')) {
        if (marker.getAttribute(kind === 'footnote' ? 'data-fn-id' : 'data-comment-id') !== id) continue
        if (kind === 'footnote') marker.remove()
        else { marker.classList.remove('nv-comment', 'nv-comment-active'); marker.removeAttribute('data-comment-id') }
      }
      controller.message({ type: 'writingChanged' })
    }
    const editor = { document, configureWritingTextMapping() {}, setWritingContext() {}, setWritingStructureEnabled() {},
      getWritingSelection: () => selection, captureWritingChanges: () => {
        const before = window.registry.getSnapshot(ref)
        return before.html === prose.innerHTML ? [] : [{ id: crypto.randomUUID(), context, origin: 'writer', kind: 'input',
          changes: [{ ref, expectedRevision: before.revision, beforeHtml: before.html, afterHtml: prose.innerHTML }],
          annotationChanges: [], beforeSelection: selection, afterSelection: selection }]
      }, writingServiceState: () => null,
      setCommentsData() {}, setFootnotesData() {}, getProofingStatus: () => null,
      restoreWritingSelection() {}, revealWritingPoint() {},
      removeFootnoteById: id => removeMarker(id, 'footnote'), removeCommentById: id => removeMarker(id, 'comment') }
    controller.ready(editor)
    useEditorBridge.getState().register(editor, 'scene')
    await act(async () => { root = createRoot(document.getElementById('host')); root.render(<Panel />) })
  }
  export async function insert(id) { await act(async () => controller.message({
    type: 'footnoteInserted', sceneId: 'scene', footnoteId: id,
    ids: [...window.registry.getAnnotations(ref).footnotes.map(note => note.id), id] })) }
  export async function edit(text) { await act(async () => {
    const input = document.querySelector('.annotation-row input')
    input.focus()
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
  }) }
  export async function remove() { await act(async () => document.querySelector('.annotation-row .binder-expand').click()) }
  export async function open() { await act(async () => useShellStore.setState({ inspectorTab: 'footnotes' })) }
  export async function replace(footnotes, comments = []) { await act(async () => window.registry.apply({
    id: crypto.randomUUID(), context, origin: 'peer', kind: 'input', changes: [],
    annotationChanges: [{ ref, before: window.registry.getAnnotations(ref), after: { comments, footnotes } }],
    beforeSelection: null, afterSelection: null })) }
  export async function changeScene() { await act(async () => useProjectStore.setState({ openSceneId: 'other' })) }
  export const notes = () => window.registry.getAnnotations(ref).footnotes
  export const snapshot = () => ({ html: window.registry.getSnapshot(ref).html, annotations: window.registry.getAnnotations(ref) })
  export async function history(direction) { let result; await act(async () => { result = await getWritingHistory(window.registry)[direction]() }); return result }
  export async function typeDraft(text) { await act(async () => {
    const input = document.querySelector('.annotation-row input')
    input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.setSelectionRange(3, 3)
  }) }
  export async function blur() { await act(async () => document.activeElement.blur()) }
  export async function unmount() { await act(async () => root.unmount()); controller.dispose() }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'annotationFixture', jsx: 'automatic',
define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'annotation-dependencies', setup(builder) {
  builder.onResolve({ filter: /./ }, args => {
    if (args.path === 'react-dom/client') return
    const key = args.path.split('/').at(-1)
    if (key in sources) return { path: key, namespace: 'fixture' }
  })
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
} }] })

async function fixture(t, mobile = false, initial) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, channels = [], calls = []
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.structuredClone = structuredClone
  w.novalist = { isMobile: mobile }
  w.removed = []
  const stored = { comments: [], footnotes: [] }
  w.request = async (method, args) => {
    calls.push({ method, args })
    if (method === 'scenes/getAnnotations') return structuredClone(stored)
    if (method === 'scenes/setAnnotations') { stored.comments = args[2]; stored.footnotes = args[3]; return }
    throw Error('Unexpected annotation RPC')
  }
  w.eval(bundle.outputFiles[0].text)
  const app = w.annotationFixture
  await app.start(initial)
  t.after(async () => { await app.unmount(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  return { w, app, calls, stored }
}

test('a newly inserted footnote appears and takes focus before its annotations reach disk', async t => {
  const f = await fixture(t)
  await f.app.insert('new-note')
  assert.equal(f.w.document.querySelectorAll('.annotation-num').length, 1)
  assert.equal(f.w.document.activeElement, f.w.document.querySelector('.annotation-row input'))
  assert.equal(f.stored.footnotes.length, 0)
  assert.equal(f.calls.length, 0, 'desktop annotations come from the retained owner')
  await f.app.insert('next-note')
  assert.equal(f.w.document.querySelectorAll('.annotation-num').length, 2)
  assert.equal(f.w.document.activeElement, f.w.document.querySelectorAll('.annotation-row input')[1])
})

test('inspector edits and deletion use the retained annotation transaction', async t => {
  const f = await fixture(t)
  await f.app.replace([{ id: 'note', number: 1, text: 'Original' }])
  await f.app.open()
  assert.equal(f.w.document.querySelectorAll('.annotation-num').length, 1)
  await f.app.edit('Changed in inspector')
  assert.equal(f.app.notes()[0].text, 'Changed in inspector')
  assert.equal(f.w.transactions.length, 1)
  await f.app.remove()
  assert.equal(f.app.notes().length, 0)
  assert.equal(f.w.document.querySelectorAll('.annotation-num').length, 0)
  assert.equal(f.calls.length, 0)
})

test('a scene change stops the previous annotation subscription from repainting its rows', async t => {
  const f = await fixture(t)
  await f.app.insert('previous')
  await f.app.changeScene()
  await f.app.replace([{ id: 'stale', number: 1, text: 'Old scene only' }])
  assert.equal(f.w.document.querySelectorAll('.annotation-num').length, 0)
})

test('mobile retains its RPC annotation editing path', async t => {
  const f = await fixture(t, true)
  f.stored.footnotes.push({ id: 'mobile-note', number: 1, text: 'Mobile original' })
  await f.app.open()
  await f.app.edit('Mobile changed')
  assert.equal(f.stored.footnotes[0].text, 'Mobile changed')
  assert.equal(f.calls.filter(call => call.method === 'scenes/setAnnotations').length, 1)
  assert.equal(f.w.transactions.length, 0)
  await f.app.remove()
  assert.equal(f.stored.footnotes.length, 0)
  assert.deepEqual([...f.w.removed], ['mobile-note'])
  assert.equal(f.w.transactions.length, 0)
})

for (const kind of ['footnote', 'comment']) test(`deleting a ${kind} restores its marker and complete record in one undo and redo`, async t => {
  const record = kind === 'footnote' ? { id: 'note', number: 1, text: 'Full footnote' }
    : { id: 'note', anchorText: 'Words', text: 'Full comment', resolved: true, author: 'Writer', createdAt: '2026-01-01',
        isTodo: true, verdict: 'accepted', replies: [{ id: 'reply', author: 'Peer', text: 'Reply', createdAt: '2026-01-02' }] }
  const initial = { html: kind === 'footnote' ? '<p>Words<sup class="nv-fn" data-fn-id="note">1</sup><sup class="nv-fn" data-fn-id="next">2</sup></p>'
    : '<p><span class="nv-comment" data-comment-id="note"><strong>Words</strong></span></p>',
  annotations: { comments: kind === 'comment' ? [record] : [], footnotes: kind === 'footnote' ? [record, { id: 'next', number: 2, text: 'Keep this note' }] : [] } }
  const f = await fixture(t, false, initial)
  await f.app.open(); await f.app.remove()
  const removed = JSON.parse(JSON.stringify(f.app.snapshot()))
  assert.equal(removed.annotations[kind === 'footnote' ? 'footnotes' : 'comments'].some(note => note.id === 'note'), false)
  assert.equal(removed.html.includes(kind === 'footnote' ? 'data-fn-id="note"' : 'data-comment-id'), false)
  if (kind === 'footnote') {
    assert.deepEqual(removed.annotations.footnotes, [{ id: 'next', number: 1, text: 'Keep this note' }])
    assert.match(removed.html, /data-fn-id="next">1<\/sup>/)
  }
  assert.equal((await f.app.history('undo')).status, 'applied')
  assert.deepEqual(JSON.parse(JSON.stringify(f.app.snapshot())), initial)
  assert.equal((await f.app.history('redo')).status, 'applied')
  assert.deepEqual(JSON.parse(JSON.stringify(f.app.snapshot())), removed)
  assert.equal(f.w.transactions.length, 1)
})

for (const kind of ['footnote', 'comment']) test(`settled ${kind} inputs reflect canonical undo and remote changes after a local blur`, async t => {
  const record = kind === 'footnote' ? { id: 'note', number: 1, text: 'Original' }
    : { id: 'note', anchorText: 'Words', text: 'Original', resolved: false }
  const f = await fixture(t, false, { html: '<p>Text</p>', annotations: {
    comments: kind === 'comment' ? [record] : [], footnotes: kind === 'footnote' ? [record] : [] } })
  const remote = text => f.app.replace(kind === 'footnote' ? [{ ...record, text }] : [], kind === 'comment' ? [{ ...record, text }] : [])
  await f.app.open(); await f.app.edit('Local edit')
  const input = f.w.document.querySelector('.annotation-row input')
  assert.equal((await f.app.history('undo')).status, 'applied')
  assert.equal(input.value, 'Original')
  await remote('Remote edit')
  assert.equal(input.value, 'Remote edit')
  await f.app.typeDraft('Unfinished draft')
  await remote('Next remote edit')
  assert.equal(f.w.document.activeElement, input)
  assert.equal(input.value, 'Unfinished draft')
  assert.equal(input.selectionStart, 3)
  await f.app.blur()
  assert.equal(f.app.snapshot().annotations[kind === 'footnote' ? 'footnotes' : 'comments'][0].text, 'Unfinished draft')
})
