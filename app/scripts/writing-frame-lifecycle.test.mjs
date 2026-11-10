import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'
import { loadRendererSource } from './renderer-source-loader.mjs'

const reference = sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId })
const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }

function dependencies(view, registry, accepted) {
  const project = create(() => ({ workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft',
    editors: { pane: { chapterGuid: 'chapter', sceneId: 'first' } }, getWritingRegistry: () => registry,
    chapters: [{ guid: 'chapter', order: 0, status: '', scenes: [
      { id: 'first', order: 0, stage: '', plotlineIds: [] }, { id: 'second', order: 1, stage: '', plotlineIds: [] }] }] }))
  const shell = create(set => ({ panes: { kind: 'leaf', writingScope: 'manuscript' },
    setPaneWritingScope: (id, writingScope) => set({ panes: { kind: 'leaf', writingScope } }) }))
  const store = { useProjectStore: project, editorPane: (state, id) => state.editors[id] }
  const shellStore = { useShellStore: shell, findPane: panes => panes }
  const history = { acceptWritingTransaction: (owner, transaction) => { owner.apply(transaction); accepted.push(transaction) } }
  const shared = { findSharedWritingSession: () => undefined }
  const { WritingPaneController } = loadRendererSource('src/views/editor/writingPaneController.ts', {
    '../../stores/projectStore': store, '../../stores/shellStore': shellStore,
    '../../stores/writingHistory': history, '../../collaboration/sharedWritingSessions': shared,
    '../../collaboration/SharedWritingHistory': { SharedWritingHistory: class {} },
    '../../collaboration/WritingSharedPresence': { WritingSharedPresence: class { update() {} close() {} } },
    '../../collaboration/sharedWritingAnnotations': {}, '../../collaboration/sharedProjectNotifications': {},
    './writingServiceScheduler': { WritingServiceScheduler: class { update() {} async dispose() {} } },
    './writingAnnotationRefresh': {}, '../../stores/writingEditingClaims': { writingEditingClaims: { blur() {} } },
    './writingTextMapping': { writingTextMapping: null }, './writingNavigation': { registerWritingNavigation: () => () => {} },
    './writingAnnotationMessages': {}, './writingAnnotationTransfers': {}
  }, { window: view, crypto: globalThis.crypto }, transformSync(readFileSync(
    new URL('../src/renderer/src/views/editor/writingPaneController.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)
  const filter = create(() => ({ filter: { status: '', character: '', location: '', plotline: '', stage: '' } }))
  const manuscript = create(() => ({ composed: null }))
  const names = { names: {}, error: null }
  const { resolveWritingProjection } = loadRendererSource('src/stores/writingProjection.ts')
  const { useUnifiedWritingDocument } = loadRendererSource('src/views/editor/useUnifiedWritingDocument.ts', {
    react: React, '../../stores/projectStore': store, '../../stores/shellStore': shellStore,
    '../../stores/writingProjection': { resolveWritingProjection },
    '../../stores/writingPersistence': { observeWritingPersistence: () => () => {} },
    '../../stores/filterStore': { useFilterStore: filter }, '../../stores/manuscriptStore': { useManuscriptStore: manuscript },
    './writingPaneController': { WritingPaneController }, './useWritingEntityNames': { useWritingEntityNames: () => names },
    '../../stores/pendingWrites': { flushPendingWrites: () => registry.flush() }, '../../collaboration/sharedWritingSessions': shared
  })
  return { useUnifiedWritingDocument, manuscript, project }
}

function installRuntime(frame, captures) {
  const view = frame.contentWindow
  if (view.NovalistWritingDocument) return view
  view.document.body.innerHTML = '<div id="editor" contenteditable="true"></div>'
  view.NovalistEditorState = { editor: view.document.getElementById('editor') }
  view.sendMessage = () => {}
  view.sceneContentFragment = html => { const template = view.document.createElement('template'); template.innerHTML = html; return template.content }
  view.toDisplayImages = () => {}
  view.clearGrammarHighlights = () => {}
  view.setWritingStructureEnabled = () => {}
  for (const file of ['writing-selection', 'writing-document', 'writing-transactions', 'content-input']) {
    view.eval(readFileSync(new URL(`../src/renderer/public/editor/${file}.js`, import.meta.url), 'utf8'))
  }
  const capture = view.captureWritingChanges
  view.captureWritingChanges = () => {
    captures.push(frame.isConnected)
    return capture()
  }
  return view
}

async function fixture(t, strict = false) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'https://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true })
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const accepted = [], captures = [], saved = new Map(), registries = []
  const { WritingDocumentRegistry } = loadRendererSource('src/stores/writingDocuments.ts', {
    './pendingWrites': { registerPendingWrite: () => () => {} }
  }, { crypto: globalThis.crypto, structuredClone })
  const createRegistry = (ownerContext = context) => {
    const owner = new WritingDocumentRegistry({ context: ownerContext, isCurrent: () => true, transport: {
      read: async ref => ({ html: `<p>${ref.sceneId}</p>`, hash: 'initial' }),
      commit: async request => {
        for (const change of request.changes) saved.set(change.ref.sceneId, change.afterHtml)
        return { status: 'committed', operationId: request.transactionId,
          hashes: request.changes.map(change => ({ ref: change.ref, hash: 'saved' })) }
      }
    } })
    registries.push(owner)
    return owner
  }
  const registry = createRegistry()
  const { useUnifiedWritingDocument, manuscript, project } = dependencies(dom.window, registry, accepted)
  let latest, frame, unmounted = false
  function Probe({ callbackRevision = 0 }) {
    latest = useUnifiedWritingDocument('pane', () => callbackRevision)
    const frameRef = React.useRef(null)
    React.useEffect(() => {
      frame = frameRef.current
      latest.adapter.ready(installRuntime(frame, captures))
    }, [])
    return React.createElement('iframe', { ref: frameRef, title: 'editor' })
  }
  const root = createRoot(dom.window.document.getElementById('host'))
  const render = async (split = false, callbackRevision = 0, key = 'initial') => React.act(async () => {
    const pane = React.createElement(Probe, { callbackRevision, key })
    const tree = split ? React.createElement('section', null, pane, React.createElement('aside')) : pane
    root.render(strict ? React.createElement(React.StrictMode, null, tree) : tree)
  })
  const unmount = async () => { if (!unmounted) { unmounted = true; await React.act(() => root.unmount()) } }
  t.after(async () => {
    try { await unmount(); for (const owner of registries) await owner.close() }
    finally { dom.window.close(); Object.assign(globalThis, previous) }
  })
  await render()
  return { registry, createRegistry, accepted, captures, saved, render, unmount, manuscript, project,
    state: () => latest, frame: () => frame,
    edit: (text, sceneId = 'first') => frame.contentWindow.getWritingSceneRoot(sceneId).querySelector('p').firstChild.appendData(text) }
}

test('splitting a dirty writing pane captures its final DOM edit before the iframe is removed', async t => {
  const f = await fixture(t)
  const originalFrame = f.frame()
  f.edit(' final pending edit')
  await f.render(true)
  assert.equal(originalFrame.isConnected, false)
  assert.ok(f.captures.every(Boolean), 'runtime capture must run while its iframe is still connected')
  assert.equal(f.registry.getSnapshot(reference('first')).html, '<p>first final pending edit</p>')
  assert.equal(f.registry.isClosed, false, 'a pane remount retains canonical ownership')
  assert.equal(f.accepted.length, 1, 'the final edit remains one history transaction')
  assert.equal(f.frame().contentWindow.serializeWritingScene('first'), '<p>first final pending edit</p>')
  await f.registry.flush()
  assert.equal(f.saved.get('first'), '<p>first final pending edit</p>')
})

test('StrictMode restart, callback refresh, scope change and final unmount keep pending edits and the retained owner', async t => {
  const f = await fixture(t, true)
  const adapter = f.state().adapter, originalFrame = f.frame()
  f.edit(' before callback')
  await f.render(false, 1)
  assert.equal(f.state().adapter, adapter)
  assert.equal(f.frame(), originalFrame)
  assert.equal(f.accepted.length, 0, 'callback refresh must not dispose or recapture the pane')
  await React.act(async () => f.manuscript.setState({ composed: ['second'] }))
  assert.equal(f.registry.getSnapshot(reference('first')).html, '<p>first before callback</p>')
  f.edit(' final second edit', 'second')
  await f.unmount()
  assert.ok(f.captures.every(Boolean), 'scope cleanup and unmount capture before DOM removal')
  assert.equal(f.registry.getSnapshot(reference('second')).html, '<p>second final second edit</p>')
  assert.equal(f.registry.isClosed, false)
  assert.equal(f.accepted.length, 2)
  await f.registry.flush()
  assert.equal(f.saved.get('first'), '<p>first before callback</p>')
  assert.equal(f.saved.get('second'), '<p>second final second edit</p>')
})

test('replacing the workspace runtime captures the departing edit into its original registry', async t => {
  const f = await fixture(t)
  const next = f.createRegistry({ ...context, workspaceEpoch: 2 })
  f.edit(' departing epoch')
  await React.act(async () => {
    f.project.setState({ workspaceEpoch: 2, getWritingRegistry: () => next })
    await f.render(false, 0, 'replacement-context')
  })
  assert.equal(f.registry.getSnapshot(reference('first')).html, '<p>first departing epoch</p>')
  assert.equal(next.getSnapshot(reference('first')).html, '<p>first</p>')
  assert.equal(f.accepted[0].context.workspaceEpoch, 1)
  f.edit(' new epoch')
  await f.unmount()
  assert.equal(next.getSnapshot(reference('first')).html, '<p>first new epoch</p>')
  assert.deepEqual(f.accepted.map(transaction => transaction.context.workspaceEpoch), [1, 2])
  assert.ok(f.captures.every(Boolean))
  assert.equal(f.registry.isClosed, false)
  assert.equal(next.isClosed, false)
})
