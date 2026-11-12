import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const result = await build({ stdin: { contents: "export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/renderer/src/collaboration/SharedEditorSession'; export * from './src/renderer/src/collaboration/SharedWritingHistory'; export * from './src/renderer/src/collaboration/richEditingSurface'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/stores/writingDocuments'; export * from './src/shared/ProseDocumentHost'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { SharedSceneSession, SharedEditorSession, SharedWritingHistory, sharedWritingSceneSurface,
  WritingDocumentRegistry, acceptSharedWritingTransaction, getWritingHistory, ProseDocumentHost } = module.exports
const paginationJobs = new WeakMap()

function runtime(t, paginated = false) {
  const dom = new JSDOM('<div id="editor-wrapper"><div id="editor" contenteditable="true"></div></div>', { runScripts: 'outside-only' })
  const w = dom.window
  t.after(() => dom.window.close())
  w.NovalistEditorState = { editor: w.document.getElementById('editor'), wrapper: w.document.getElementById('editor-wrapper') }
  w.sendMessage = () => {}
  w.sceneContentFragment = html => { const template = w.document.createElement('template'); template.innerHTML = html; return template.content }
  w.sanitizeSceneFragment = w.sceneContentFragment
  w.repaginatePageView = () => {}
  w.schedulePageViewRepaginate = () => {}
  w.clearGrammarHighlights = () => {}
  for (const file of ['editor-content', 'writing-selection', 'writing-document', 'writing-transactions', 'content-input', 'prose-direction']) {
    w.eval(readFileSync(new URL(`../src/renderer/public/editor/${file}.js`, import.meta.url), 'utf8'))
  }
  if (paginated) {
    const jobs = []
    paginationJobs.set(w, jobs)
    w.setTimeout = callback => { jobs.push(callback); return jobs.length }
    w.NovalistEditorState.editor.style.fontSize = '16px'
    Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return this.tagName === 'P' ? 96 : 0 } })
    w.clearGrammarHighlights = () => {}
    w.captureDictationPosition = () => null
    w.restoreDictationPosition = () => {}
    w.reapplyReadability = () => {}
    w.eval(readFileSync(new URL('../src/renderer/public/editor/page-layout.js', import.meta.url), 'utf8'))
  }
  return w
}

async function flushPagination(panes) {
  await Promise.resolve()
  for (const [index, pane] of panes.entries()) {
    const jobs = paginationJobs.get(pane)
    assert.ok(jobs.length > 0, 'owner rendering must enqueue real pagination')
    const selection = pane.getSelection()
    const before = [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]
    for (const callback of jobs.splice(0)) callback()
    assert.ok(pane.getWritingSceneRoot('typing').querySelectorAll('.nv-page').length > 1)
    assert.ok(pane.getWritingSceneRoot('remote').querySelector('.nv-page'))
    assert.equal(selection.anchorNode, before[0])
    assert.equal(selection.anchorOffset, before[1])
    assert.equal(selection.focusNode, before[2])
    assert.equal(selection.focusOffset, before[3])
    assert.equal(selection.isCollapsed, index === 0)
    if (index === 1) assert.ok(selection.anchorOffset > selection.focusOffset, 'reverse selection remains reversed')
  }
}

for (const paginated of [false, true]) test(`two shared pane runtimes acknowledge rendered state before global capture and keep one local undo (pages=${paginated})`, async t => {
  const panes = [runtime(t, paginated), runtime(t, paginated)]
  const previousObserver = globalThis.MutationObserver
  globalThis.MutationObserver = panes[0].MutationObserver
  t.after(() => { globalThis.MutationObserver = previousObserver })
  const environment = { document: panes[0].document, sanitizeSceneFragment: panes[0].sceneContentFragment, toDisplayImages() {} }
  const host = new ProseDocumentHost(environment.document, environment)
  const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const directions = '<p dir="ltr">Left</p><p dir="rtl">Right</p><p dir="auto">Auto</p><ul dir="auto"><li>List</li></ul><blockquote style="direction: rtl;">Styled</blockquote>'
  const longScene = (paginated ? `<p>${'long scene words '.repeat(26)}</p>`.repeat(320) : '') + directions
  const documents = ['typing', 'remote'].map(sceneId => {
    const server = new Y.Doc()
    const state = host.seed(sceneId, `<p><b>${sceneId}</b> text</p>${sceneId === 'typing' ? longScene : ''}`)
    Y.applyUpdate(server, state)
    const connection = { read: async () => Y.encodeStateAsUpdate(server), write: async update => Y.applyUpdate(server, update), subscribe: () => () => {} }
    return { server, state, connection, owner: new SharedSceneSession(environment, state, connection),
      ref: { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId } }
  })
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
    read: async ref => ({ html: documents.find(value => value.ref.sceneId === ref.sceneId).owner.html,
      hash: 'initial', shared: { sessionId: 'session', itemId: ref.sceneId, state: '' } }),
    activate: async () => true, commit: async () => assert.fail('Shared changes must use their existing Yjs transport')
  } })
  const snapshots = await Promise.all(documents.map(value => registry.read(value.ref)))
  const owners = new Map(documents.map(value => [value.ref.sceneId, value.owner]))
  const histories = panes.map(() => new SharedWritingHistory())
  const capture = index => {
    for (const transaction of panes[index].captureWritingChanges()) {
      acceptSharedWritingTransaction(registry, transaction, histories[index], owners)
    }
  }
  const bindings = panes.flatMap((pane, index) => {
    pane.setWritingContext(context, `pane-${index}`)
    pane.setWritingProjection(snapshots, null)
    return documents.map((value, sceneIndex) => new SharedEditorSession(
      sharedWritingSceneSurface(pane, value.ref.sceneId, () => capture(index)), value.state, value.connection,
      () => pane.acknowledgeWritingScene({ ...snapshots[sceneIndex], html: value.owner.html, revision: value.owner.revision }), value.owner))
  })
  if (paginated) for (const [index, pane] of panes.entries()) {
    for (const document of documents) pane.NovalistWritingDocument.visible.add(document.ref.sceneId)
    const text = pane.getWritingSceneRoot('typing').querySelector('b').firstChild
    pane.getSelection().setBaseAndExtent(text, index === 0 ? 3 : 5, text, index === 0 ? 3 : 1)
    pane.setPageView(true)
  }
  if (paginated) for (const pane of panes) {
    assert.ok(pane.getWritingSceneRoot('typing').querySelector('.nv-page'), 'the paginated variant must create actual page wrappers')
  }
  t.after(async () => {
    for (const binding of bindings) binding.detach()
    for (const value of documents) { await value.owner.close(); value.server.destroy() }
    for (const history of histories) history.dispose()
    await registry.close()
    host.dispose()
  })
  panes[0].getWritingSceneRoot('typing').querySelector('p').append(' local')
  panes[0].applyProseDirection(panes[0].getWritingSceneRoot('typing'))
  assert.equal(panes[0].getWritingSceneRoot('typing').querySelector('p').getAttribute('data-nv-auto-direction'), '')
  capture(0)
  documents[1].server.getText('prose').insert(0, 'Peer ')
  documents[1].owner.receive(Y.encodeStateAsUpdate(documents[1].server))
  assert.doesNotThrow(() => { capture(0); capture(1) })
  assert.equal(documents[0].owner.html, `<p><b>typing</b> text local</p>${longScene}`)
  for (const pane of panes) assert.equal(pane.serializeWritingScene('typing'), `<p><b>typing</b> text local</p>${longScene}`)
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  if (paginated) await flushPagination(panes)
  for (const pane of panes) {
    assert.equal(pane.serializeWritingScene('typing'), `<p><b>typing</b> text</p>${longScene}`)
    assert.equal(pane.serializeWritingScene('remote'), '<p>Peer <b>remote</b> text</p>')
    assert.equal(pane.captureWritingChanges().length, 0)
  }
  if (paginated) for (let index = 0; index < 12; index++) {
    const previousPages = panes.map(pane => pane.getWritingSceneRoot('typing').querySelector('.nv-page'))
    panes[0].getWritingSceneRoot('typing').querySelector('b').firstChild.appendData('x')
    capture(0)
    await flushPagination(panes)
    for (const [paneIndex, pane] of panes.entries()) {
      assert.notEqual(pane.getWritingSceneRoot('typing').querySelector('.nv-page'), previousPages[paneIndex])
      assert.equal(previousPages[paneIndex].isConnected, false)
    }
    await documents[0].owner.flush()
    capture(0); capture(1)
    for (const pane of panes) {
      assert.equal(pane.serializeWritingScene('typing'), `<p><b>typing${'x'.repeat(index + 1)}</b> text</p>${longScene}`)
      assert.equal(pane.captureWritingChanges().length, 0)
    }
  }
  for (const text of ['a', 'bc', 'd']) {
    panes[0].getWritingSceneRoot('typing').querySelector('b').firstChild.appendData(text)
    panes[0].queueWritingChanges()
  }
  if (paginated) {
    documents[0].server.getText('prose').insert(0, 'Peer ')
    documents[0].owner.receive(Y.encodeStateAsUpdate(documents[0].server))
  } else capture(0)
  if (paginated) await flushPagination(panes)
  for (const pane of panes) {
    assert.equal(pane.captureWritingChanges().length, 0, 'intermediate owner renders must not create rollback transactions')
  }
  await documents[0].owner.flush()
  if (!paginated) {
    documents[0].server.getText('prose').insert(0, 'Peer ')
    documents[0].owner.receive(Y.encodeStateAsUpdate(documents[0].server))
  }
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  if (paginated) await flushPagination(panes)
  for (const pane of panes) {
    assert.equal(pane.serializeWritingScene('typing'), `<p>Peer <b>typing${paginated ? 'x'.repeat(12) : ''}abc</b> text</p>${longScene}`)
    assert.equal(pane.captureWritingChanges().length, 0)
  }
})
