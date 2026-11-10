import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const result = await build({ stdin: { contents: "export * from './src/renderer/src/collaboration/SharedWritingHistory'; export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/renderer/src/collaboration/SharedEditorSession'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/stores/writingDocuments'; export * from './src/shared/ProseDocumentHost'; export * from './src/renderer/src/collaboration/sharedWritingSelection'; export * from './src/renderer/src/views/editor/writingTextMapping'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { SharedWritingHistory, SharedSceneSession, SharedEditorSession, WritingDocumentRegistry, acceptSharedWritingTransaction, getWritingHistory, ProseDocumentHost, retainSharedWritingSelection, writingTextMapping } = module.exports

function fixture(t) {
  const dom = new JSDOM('<div id="one"></div><div id="two"></div>')
  const document = dom.window.document
  const previous = globalThis.MutationObserver
  globalThis.MutationObserver = dom.window.MutationObserver
  t.after(() => { globalThis.MutationObserver = previous; dom.window.close() })
  const environment = { document, sanitizeSceneFragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content }, toDisplayImages() {} }
  const sessions = []
  const create = text => {
    const server = new Y.Doc()
    const prose = server.getText('prose')
    prose.insert(0, text)
    prose.insert(text.length, '\n', { block: JSON.stringify([{ id: text, tag: 'p', attributes: {} }]) })
    let fail = false
    const connection = { read: async () => Y.encodeStateAsUpdate(server), write: async update => { if (fail) throw new Error('offline'); Y.applyUpdate(server, update) }, subscribe: () => () => {} }
    const owner = new SharedSceneSession(environment, Y.encodeStateAsUpdate(server), connection)
    sessions.push(owner)
    t.after(() => server.destroy())
    return { owner, server, connection, fail: value => { fail = value } }
  }
  t.after(async () => { for (const owner of sessions) await owner.close() })
  const surface = id => {
    const root = document.getElementById(id)
    return { ...environment, root, getContent: () => root.innerHTML, getPlainText: () => root.textContent, flushPendingContentChange() {} }
  }
  return { create, surface, environment }
}

test('one grouped undo removes only local edits across two shared scenes after a peer insertion', async t => {
  const f = fixture(t)
  const first = f.create('First')
  const second = f.create('Second')
  const history = new SharedWritingHistory()
  history.begin('group', 'writer')
  history.capture('one', { session: first.owner, apply: prose => prose.insert(5, ' local') })
  history.capture('two', { session: second.owner, apply: prose => prose.insert(6, ' local') })
  history.commit('group')
  await Promise.all([first.owner.flush(), second.owner.flush()])
  first.server.getText('prose').insert(0, 'Peer ')
  first.owner.receive(Y.encodeStateAsUpdate(first.server))
  assert.equal((await history.undo('group')).status, 'applied')
  assert.equal(first.owner.prose.toString(), 'Peer First\n')
  assert.equal(second.owner.prose.toString(), 'Second\n')
  assert.equal((await history.redo('group')).status, 'applied')
  assert.equal(first.owner.prose.toString(), 'Peer First local\n')
})

test('retained document history and failed sends survive binding detach and remount', async t => {
  const f = fixture(t)
  const shared = f.create('Original')
  const statuses = []
  const surface = f.surface('one')
  const binding = new SharedEditorSession(surface, Y.encodeStateAsUpdate(shared.server), shared.connection, status => statuses.push(status), shared.owner)
  shared.fail(true)
  surface.root.querySelector('p').textContent = 'Original local'
  binding.capture()
  binding.detach()
  await assert.rejects(shared.owner.flush())
  assert.equal(shared.owner.dirty, true)
  const nextSurface = f.surface('two')
  const next = new SharedEditorSession(nextSurface, Y.encodeStateAsUpdate(shared.server), shared.connection, () => {}, shared.owner)
  assert.equal(nextSurface.getPlainText(), 'Original local')
  shared.owner.undo()
  assert.equal(nextSurface.getPlainText(), 'Original')
  shared.fail(false)
  await next.flush()
  next.detach()
  assert.equal(shared.server.getText('prose').toString(), 'Original\n')
})

test('composition pins shared binding and blocks grouped undo before any scene changes', async t => {
  const f = fixture(t)
  const shared = f.create('Original')
  const surface = f.surface('one')
  const binding = new SharedEditorSession(surface, Y.encodeStateAsUpdate(shared.server), shared.connection, () => {}, shared.owner)
  const history = new SharedWritingHistory()
  history.begin('group', 'writer')
  history.capture('one', { session: shared.owner, apply: prose => prose.insert(0, 'local ') })
  history.commit('group')
  surface.root.dispatchEvent(new surface.document.defaultView.CompositionEvent('compositionstart', { bubbles: true }))
  assert.throws(() => binding.detach(), /composition/i)
  assert.equal((await history.undo('group')).status, 'blocked')
  shared.server.getText('prose').insert(0, 'Peer ')
  shared.owner.receive(Y.encodeStateAsUpdate(shared.server))
  assert.equal(surface.getPlainText(), 'local Original')
  surface.root.dispatchEvent(new surface.document.defaultView.CompositionEvent('compositionend', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await history.undo('group')).status, 'applied')
  assert.equal(surface.getPlainText(), 'Peer Original')
  binding.detach()
})

test('two panes share one retained document and writer undo without discarding a newer pane edit', async t => {
  const f = fixture(t)
  const shared = f.create('Original')
  const first = f.surface('one')
  const second = f.surface('two')
  const bindings = [first, second].map(surface => new SharedEditorSession(surface, Y.encodeStateAsUpdate(shared.server), shared.connection, () => {}, shared.owner))
  first.root.querySelector('p').textContent = 'Original first'
  first.root.dispatchEvent(new first.document.defaultView.InputEvent('input', { bubbles: true }))
  assert.equal(second.getPlainText(), 'Original first')
  shared.owner.history.stopCapturing()
  second.root.querySelector('p').textContent = 'Original first second'
  second.root.dispatchEvent(new second.document.defaultView.InputEvent('input', { bubbles: true }))
  assert.equal(first.getPlainText(), 'Original first second')
  shared.owner.undo()
  assert.equal(first.getPlainText(), 'Original first')
  assert.equal(second.getPlainText(), 'Original first')
  for (const binding of bindings) binding.detach()
})

test('a managed mixed local/shared action stays one undo after remote insertion', async t => {
  const f = fixture(t)
  const shared = f.create('Original')
  const surface = f.surface('one')
  surface.managedTransactions = true
  const binding = new SharedEditorSession(surface, Y.encodeStateAsUpdate(shared.server), shared.connection, () => {}, shared.owner)
  const secondSurface = f.surface('two')
  secondSurface.managedTransactions = true
  const secondBinding = new SharedEditorSession(secondSurface, Y.encodeStateAsUpdate(shared.server), shared.connection, () => {}, shared.owner)
  const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const ref = sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId })
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
    read: async reference => ({ html: '<p>Original</p>', hash: 'initial', shared: reference.sceneId === 'one' ? { sessionId: 'session', itemId: 'item', state: '' } : null }),
    activate: async () => true, commit: async request => ({ status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
  } })
  await Promise.all(['local', 'one'].map(sceneId => registry.read(ref(sceneId))))
  const history = new SharedWritingHistory()
  surface.root.querySelector('p').textContent = 'Original edited'
  surface.root.dispatchEvent(new surface.document.defaultView.InputEvent('input', { bubbles: true }))
  await Promise.resolve()
  assert.equal(shared.owner.prose.toString(), 'Original\n', 'managed surface waits for the grouped host transaction')
  acceptSharedWritingTransaction(registry, { id: 'mixed', context, origin: 'writer', kind: 'replace',
    changes: ['local', 'one'].map(sceneId => ({ ref: ref(sceneId), expectedRevision: 0, beforeHtml: '<p>Original</p>', afterHtml: '<p>Original edited</p>' })),
    annotationChanges: [], beforeSelection: null, afterSelection: null }, history, new Map([['one', shared.owner]]))
  assert.equal(secondSurface.getPlainText(), 'Original edited', 'a stale second pane must not overwrite the initiating pane')
  await shared.owner.flush()
  shared.server.getText('prose').insert(0, 'Peer ')
  shared.owner.receive(Y.encodeStateAsUpdate(shared.server))
  surface.captureWritingTransaction = () => acceptSharedWritingTransaction(registry, {
    id: 'pending-before-undo', context, origin: 'writer', kind: 'input',
    changes: [{ ref: ref('one'), expectedRevision: shared.owner.revision, beforeHtml: shared.owner.html, afterHtml: surface.getContent() }],
    annotationChanges: [], beforeSelection: null, afterSelection: null
  }, history, new Map([['one', shared.owner]]))
  surface.root.querySelector('p').textContent = 'Peer Original edited pending'
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  assert.equal(surface.getPlainText(), 'Peer Original edited', 'undo captures and removes the newest pending input first')
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  assert.equal(registry.getSnapshot(ref('local')).html, '<p>Original</p>')
  assert.equal(surface.getPlainText(), 'Peer Original')
  assert.equal((await getWritingHistory(registry).redo()).status, 'applied')
  assert.equal(registry.getSnapshot(ref('local')).html, '<p>Original edited</p>')
  assert.equal(surface.getPlainText(), 'Peer Original edited')
  binding.detach()
  secondBinding.detach()
  await registry.close()
  history.dispose()
})

test('a remote update captures pending managed input through the synchronous writer transaction', async t => {
  const f = fixture(t)
  const shared = f.create('Original')
  const surface = f.surface('one')
  surface.managedTransactions = true
  const history = new SharedWritingHistory()
  let captures = 0
  surface.captureWritingTransaction = () => {
    captures++
    const apply = shared.owner.prepareChange(surface.getContent())
    history.begin('pending', 'writer')
    history.capture('one', { session: shared.owner, apply })
    history.commit('pending')
  }
  const binding = new SharedEditorSession(surface, Y.encodeStateAsUpdate(shared.server), shared.connection, () => {}, shared.owner)
  surface.root.querySelector('p').textContent = 'Original pending'
  shared.server.getText('prose').insert(0, 'Peer ')
  shared.owner.receive(Y.encodeStateAsUpdate(shared.server))
  assert.equal(captures, 1)
  assert.equal(surface.getPlainText(), 'Peer Original pending')
  assert.equal((await history.undo('pending')).status, 'applied')
  assert.equal(surface.getPlainText(), 'Peer Original')
  binding.detach()
  history.dispose()
})

test('hidden dirty shared documents keep the existing recovered-copy behavior after remote deletion', async t => {
  const f = fixture(t)
  const host = new ProseDocumentHost(f.environment.document, f.environment)
  const state = host.seed('scene', '<p>Original</p>')
  const owner = new SharedSceneSession(f.environment, state, {
    read: async () => host.state('scene'), subscribe: () => () => {},
    write: async update => { host.receive('scene', update) }
  })
  const history = new SharedWritingHistory()
  host.remove('scene', state)
  history.begin('offline', 'writer')
  history.capture('scene', { session: owner, apply: prose => prose.insert(8, ' retained') })
  history.commit('offline')
  await owner.flush()
  assert.equal(host.project('scene'), null)
  assert.equal(host.recovered('scene'), '<p>Original retained</p>')
  history.dispose()
  await owner.close()
  host.dispose()
})

test('shared cross-scene undo restores relative endpoints after peer insertions in either scene', async t => {
  const f = fixture(t)
  const first = f.create('First')
  const second = f.create('Second')
  const sessions = new Map([['one', first.owner], ['two', second.owner]])
  const before = { anchor: { sceneId: 'one', offset: 1, affinity: 'after' }, focus: { sceneId: 'two', offset: 3, affinity: 'before' } }
  const retained = retainSharedWritingSelection(before, sessions)
  const history = new SharedWritingHistory()
  history.begin('selection', 'writer')
  history.capture('one', { session: first.owner, apply: prose => prose.insert(5, ' local') })
  history.capture('two', { session: second.owner, apply: prose => prose.insert(6, ' local') })
  history.commit('selection')
  history.setSelections('selection', retained, retainSharedWritingSelection(before, sessions))
  await Promise.all([first.owner.flush(), second.owner.flush()])
  first.server.getText('prose').insert(0, 'Peer ')
  second.server.getText('prose').insert(0, 'Remote ')
  first.owner.receive(Y.encodeStateAsUpdate(first.server))
  second.owner.receive(Y.encodeStateAsUpdate(second.server))
  const undone = await history.undo('selection')
  assert.deepEqual(undone.selection, { anchor: { ...before.anchor, offset: 6 }, focus: { ...before.focus, offset: 10 } })
  assert.deepEqual((await history.redo('selection')).selection, undone.selection)
  history.dispose()
})

test('one canonical UTF16 mapping covers empty paragraphs, BR, headings, surrogate pairs and embeds', async t => {
  const f = fixture(t)
  const host = new ProseDocumentHost(f.environment.document, f.environment)
  const html = '<h1>Heading</h1><p></p><p><br></p><p><img src="image.png">A\uD835\uDC00<sup>1</sup>B</p>'
  const state = host.seed('scene', html)
  const owner = new SharedSceneSession(f.environment, state, {
    read: async () => host.state('scene'), subscribe: () => () => {}, write: async update => { host.receive('scene', update) }
  })
  const root = f.environment.document.createElement('div')
  root.innerHTML = html
  const text = writingTextMapping.parts(root).map(part => part.text).join('')
  assert.equal(text, 'Heading\n\n\nA\uD835\uDC001B\n')
  for (let offset = 0; offset <= text.length; offset++) {
    for (const affinity of ['before', 'after']) {
      const point = writingTextMapping.domPoint(root, offset, affinity)
      assert.equal(writingTextMapping.offset(root, point.node, point.offset), offset, `DOM ${offset} ${affinity}`)
      const relative = owner.relativePoint({ sceneId: 'scene', offset, affinity })
      assert.equal(owner.resolvePoint(relative), offset, `Yjs ${offset} ${affinity}`)
    }
  }
  await owner.close()
  host.dispose()
})
