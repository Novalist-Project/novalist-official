import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { InboxPanel } from './src/renderer/src/shell/InboxPanel'
  import { AnnotationsPanel } from './src/renderer/src/shell/AnnotationsPanel'
  import { WritingDocumentRegistry } from './src/renderer/src/stores/writingDocuments'
  import { WritingPaneController } from './src/renderer/src/views/editor/writingPaneController'
  import { getWritingHistory } from './src/renderer/src/stores/writingHistory'
  import { getSharedWritingAnnotations, closeSharedWritingAnnotations } from './src/renderer/src/collaboration/sharedWritingAnnotations'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  export { act }
  const context = { workspaceId: '/inbox', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const ref = sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId })
  let registry, controller, root, releaseCapture
  const pending = []
  export async function start(shared) {
    registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
      read: async target => ({ html: '<p>Prose.</p>', hash: 'hash', annotations: window.stored.get(target.sceneId),
        shared: shared ? { sessionId: 'session', itemId: target.sceneId, state: '' } : null }),
      activate: async () => true,
      commit: async request => {
        if (shared) throw Error('Shared annotations used local persistence')
        for (const change of request.annotationChanges) {
          window.assertAnnotations(window.stored.get(change.ref.sceneId), change.before)
          window.stored.set(change.ref.sceneId, structuredClone(change.after))
        }
        for (const change of request.changes) window.savedProse = change.afterHtml
        return { status: 'committed', operationId: request.transactionId,
          hashes: [...request.changes, ...request.annotationChanges].map(change => ({ ref: change.ref, hash: 'hash' })) }
      }
    } })
    await registry.read(ref('scene'))
    useProjectStore.setState({ projectPath: context.workspaceId, workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft',
      isLoaded: true, openChapterGuid: 'chapter', openSceneId: 'scene', activeEditorPaneId: 'pane', editors: {},
      chapters: [{ guid: 'chapter', title: 'Chapter', scenes: ['scene', 'offscreen'].map(id => ({ id, title: id })) }],
      getWritingRegistry: () => registry })
    controller = new WritingPaneController('pane', { ready() {}, selection() {}, projection() {}, error(error) { throw Error(error) }, structure() {} })
    controller.registry = registry; controller.references.set('scene', ref('scene'))
    controller.ready({ document, configureWritingTextMapping() {}, setWritingContext() {}, setWritingStructureEnabled() {},
      captureWritingChanges: () => pending.splice(0), getWritingSelection: () => null, writingServiceState: () => null,
      setCommentsData() {}, setFootnotesData() {} })
    releaseCapture = registry.registerCapture(controller.capture)
    await act(async () => { root = createRoot(document.getElementById('root')); root.render(<><InboxPanel /><AnnotationsPanel chapterGuid="chapter" sceneId="scene" /></>) })
  }
  export const annotations = (scene = 'scene') => registry.getAnnotations(ref(scene))
  export async function history(direction) { let result; await act(async () => { result = await getWritingHistory(registry)[direction]() }); return result }
  export async function flush() { await act(async () => { await registry.flush(); await getSharedWritingAnnotations(registry).flush() }) }
  export async function editInPanel(text) { await act(async () => {
    const input = document.querySelector('.annotation-comment .outliner-input')
    input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur()
  }) }
  export async function addComment() { await act(async () => controller.message({ type: 'commentAdded', sceneId: 'scene', commentId: 'unsaved', anchorText: 'Prose' })) }
  export function queueProse(html) {
    const before = registry.getSnapshot(ref('scene'))
    pending.push({ id: crypto.randomUUID(), context, origin: 'typing', kind: 'input',
      changes: [{ ref: ref('scene'), beforeHtml: before.html, afterHtml: html, expectedRevision: before.revision }],
      annotationChanges: [], beforeSelection: null, afterSelection: null })
  }
  export async function editInGutter(text) { await act(async () => controller.message({ type: 'commentTextChanged', sceneId: 'scene', commentId: 'same-id', text })) }
  export const prose = () => registry.getSnapshot(ref('scene')).html
  export async function removeSurface() { controller.dispose(); useProjectStore.setState({ activeEditorPaneId: null }) }
  export async function changeWorkspace() { await act(async () => useProjectStore.setState({ workspaceBusy: true })) }
  export async function close() { await act(async () => root.unmount()); releaseCapture(); controller.dispose(); await registry.close(); await closeSharedWritingAnnotations(context.workspaceId) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'inboxFixture', jsx: 'automatic',
define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'inbox-host', setup(builder) {
  const sources = {
    projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({})); export const editorPane = () => ({})`,
    shellStore: `import { create } from 'zustand'; export const useShellStore = create(() => ({ pendingFootnoteText: null }))`,
    settingsStore: `export const useSettingsStore = { getState: () => ({ view: { project: { author: 'Local writer' } } }) }`,
    writingError: `export const writingErrorMessage = value => value`,
    client: `export const rpc = { request: (...args) => window.request(...args) }`,
    'react-i18next': `export const useTranslation = () => ({ t: key => key })`,
    sharedProjectNotifications: `import { create } from 'zustand'; export const useSharedProjectRevision = create(() => 0)`,
    writingEditingClaims: `export const writingEditingClaims = { focus() {}, blur() {} }`,
    WritingSharedPresence: `export class WritingSharedPresence { update() {} close() {} }`,
    sharedWritingSessions: `export const findSharedWritingSession = () => undefined; export const getSharedWritingSession = () => undefined; export const createSharedWritingBinding = () => undefined`
  }
  builder.onResolve({ filter: /./ }, args => {
    if (args.path === 'react-dom/client') return
    const key = args.path.split('/').at(-1)
    if (key in sources) return { path: key, namespace: 'fixture' }
  })
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
} }] })

const comment = { id: 'same-id', anchorText: 'Prose', text: 'Initial comment', resolved: false, createdAt: '2026-01-01T00:00:00.000Z',
  author: 'Peer', isTodo: false, verdict: null, replies: [{ id: 'old-reply', author: 'Peer', text: 'Original reply', createdAt: '2026-01-02T00:00:00.000Z' }] }
const initial = { comments: [comment], footnotes: [{ id: 'note', number: 1, text: 'Footnote' }] }
const plain = value => JSON.parse(JSON.stringify(value))

async function fixture(t, shared = false, mobile = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, channels = [], calls = []
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true; w.structuredClone = structuredClone; w.novalist = { isMobile: mobile }
  w.assertAnnotations = (actual, expected) => assert.deepEqual(plain(actual), plain(expected), 'Annotation provenance conflict')
  w.stored = new Map(['scene', 'offscreen'].map(id => [id, structuredClone(initial)]))
  const rows = resolved => [...w.stored].flatMap(([sceneId, value]) => value.comments.filter(c => resolved || !c.resolved).map(c => ({
    ...c, commentId: c.id, chapterGuid: 'chapter', chapterTitle: 'Chapter', sceneId, sceneTitle: sceneId, replies: c.replies ?? [], verdict: c.verdict ?? ''
  })))
  w.request = async (method, args = []) => {
    calls.push(method)
    if (method === 'suggestions/inbox') return []
    if (method === 'inbox/list') return structuredClone(rows(args[0]))
    if (method === 'scenes/getAnnotations') return structuredClone(w.stored.get(args[1]))
    if (method === 'writing/commitSharedAnnotations') {
      const request = args[0]
      for (const change of request.changes) {
        assert.deepEqual(plain(change.before), plain(w.stored.get(change.ref.sceneId)), 'Shared annotation provenance')
        w.stored.set(change.ref.sceneId, structuredClone(change.after))
      }
      return { status: 'committed', operationId: request.transactionId, annotations: request.changes.map(c => ({ ref: c.ref, annotations: c.after })) }
    }
    if (method.startsWith('inbox/')) {
      const record = w.stored.get(args[0]).comments.find(c => c.id === args[1])
      if (method === 'inbox/setTodo') record.isTodo = args[2]
      if (method === 'inbox/setResolved') record.resolved = args[2]
      if (method === 'inbox/setVerdict') { record.verdict = args[2]; if (['accepted', 'declined'].includes(args[2])) record.resolved = true }
      if (method === 'inbox/reply') record.replies.push({ id: 'rpc-reply', author: 'Local writer', text: args[2], createdAt: new Date().toISOString() })
      return rows(false)
    }
    throw Error('Unexpected Inbox RPC: ' + method)
  }
  w.eval(bundle.outputFiles[0].text)
  const app = w.inboxFixture
  await app.start(shared)
  t.after(async () => { await app.close(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  const row = (scene = 'scene') => [...w.document.querySelectorAll('.inbox-item')].find(item => item.querySelector('.inbox-where').textContent === 'Chapter - ' + scene)
  const click = async (action, scene = 'scene') => {
    const button = [...row(scene).querySelectorAll('button')].find(button => button.title === action || button.textContent === action)
    assert.ok(button, 'Missing Inbox action ' + action)
    await app.act(async () => button.click())
  }
  const reply = async scene => {
    await click('inbox.reply', scene)
    await app.act(async () => {
      const input = row(scene).querySelector('input')
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, 'A new answer')
      input.dispatchEvent(new w.Event('input', { bubbles: true }))
    })
    await app.act(async () => row(scene).querySelector('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  }
  return { w, app, calls, row, click, reply }
}

const actions = ['makeTodo', 'resolve', 'accepted', 'declined', 'reply']
for (const shared of [false, true]) for (const action of actions) test(`Inbox ${action} is canonical, undoable and permits later annotation saves (shared=${shared})`, async t => {
  const f = await fixture(t, shared)
  if (action === 'reply') await f.reply('scene')
  else await f.click(action === 'accepted' || action === 'declined' ? 'inbox.verdict.' + action : 'inbox.' + action)
  const after = plain(f.app.annotations())
  const changed = after.comments[0]
  if (action === 'makeTodo') assert.equal(changed.isTodo, true)
  if (action === 'resolve') assert.equal(changed.resolved, true)
  if (action === 'accepted' || action === 'declined') { assert.equal(changed.verdict, action); assert.equal(changed.resolved, true) }
  if (action === 'reply') {
    assert.equal(changed.replies.length, 2); assert.equal(changed.replies[1].text, 'A new answer')
    assert.equal(changed.replies[1].author, 'Local writer'); assert.ok(Date.parse(changed.replies[1].createdAt)); assert.notEqual(changed.replies[1].id, 'old-reply')
  }
  assert.deepEqual(after.footnotes, initial.footnotes)
  assert.equal(f.calls.some(call => /^inbox\/(set|reply)/.test(call)), false)
  assert.equal((await f.app.history('undo')).status, 'applied'); assert.deepEqual(plain(f.app.annotations()), initial)
  assert.equal((await f.app.history('redo')).status, 'applied'); assert.deepEqual(plain(f.app.annotations()), after)
  await f.app.editInPanel('Later inspector edit')
  await f.app.flush()
  assert.deepEqual(plain(f.w.stored.get('scene')), { ...after, comments: [{ ...changed, text: 'Later inspector edit' }] })
})

for (const shared of [false, true]) test(`Inbox edits an offscreen scene with a duplicate comment ID without mounting it (shared=${shared})`, async t => {
  const f = await fixture(t, shared)
  await f.app.removeSurface()
  await f.click('inbox.makeTodo', 'offscreen')
  assert.equal(f.app.annotations('offscreen')?.comments[0].isTodo, true)
  assert.deepEqual(plain(f.app.annotations('scene')), initial)
  assert.equal((await f.app.history('undo')).status, 'applied')
  assert.equal(f.app.annotations('offscreen').comments[0].isTodo, false)
})

test('Inbox overlays unsaved comments and undo immediately, then discards a retired workspace', async t => {
  const f = await fixture(t)
  await f.app.addComment()
  assert.equal(f.w.document.querySelectorAll('.inbox-item').length, 3)
  assert.equal(f.w.stored.get('scene').comments.length, 1)
  await f.app.history('undo')
  assert.equal(f.w.document.querySelectorAll('.inbox-item').length, 2)
  await f.app.changeWorkspace()
  assert.equal(f.w.document.querySelectorAll('.inbox-item').length, 0)
})

test('Inbox captures pending prose and a subsequent gutter edit saves without stale provenance', async t => {
  const f = await fixture(t)
  f.app.queueProse('<p>Unsaved <b>prose</b>.</p>')
  await f.click('inbox.makeTodo')
  assert.equal(f.app.prose(), '<p>Unsaved <b>prose</b>.</p>')
  await f.app.history('undo')
  assert.equal(f.app.annotations().comments[0].isTodo, false)
  assert.equal(f.app.prose(), '<p>Unsaved <b>prose</b>.</p>')
  await f.app.history('redo')
  await f.app.editInGutter('Later gutter edit')
  await f.app.flush()
  assert.equal(f.w.savedProse, '<p>Unsaved <b>prose</b>.</p>')
  assert.equal(f.w.stored.get('scene').comments[0].text, 'Later gutter edit')
  assert.equal(f.w.stored.get('scene').comments[0].isTodo, true)
})

for (const [action, method] of [['makeTodo', 'setTodo'], ['resolve', 'setResolved'], ['accepted', 'setVerdict'], ['reply', 'reply']]) test(`mobile Inbox preserves its existing ${method} RPC path`, async t => {
  const f = await fixture(t, false, true)
  if (action === 'reply') await f.reply('scene')
  else await f.click(action === 'accepted' ? 'inbox.verdict.accepted' : 'inbox.' + action)
  assert.ok(f.calls.includes('inbox/' + method))
  assert.deepEqual(plain(f.app.annotations()), initial)
  assert.notDeepEqual(plain(f.w.stored.get('scene')), initial)
})
