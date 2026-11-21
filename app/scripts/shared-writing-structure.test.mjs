import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const result = await build({ stdin: { contents: "export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/renderer/src/collaboration/sharedWritingStructure'; export * from './src/shared/ProseDocumentHost'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { SharedSceneSession, prepareSharedWritingSplit, ProseDocumentHost } = module.exports
const decode = value => Uint8Array.from(Buffer.from(value, 'base64'))

function fixture(t, html = '<p>Alpha beta</p>') {
  const dom = new JSDOM('<body></body>')
  const document = dom.window.document
  const environment = { document, sanitizeSceneFragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content }, toDisplayImages() {} }
  const host = new ProseDocumentHost(document, environment)
  const state = host.seed('source', html)
  const server = new Y.Doc()
  Y.applyUpdate(server, state)
  const owner = new SharedSceneSession(environment, state, { read: async () => Y.encodeStateAsUpdate(server), subscribe: () => () => {}, write: async update => Y.applyUpdate(server, update) })
  t.after(async () => { await owner.close(); server.destroy(); host.dispose(); dom.window.close() })
  return { owner, server, host, environment, identity: { sessionId: 'session', itemId: 'source', state: Buffer.from(state).toString('base64') } }
}

test('shared split keeps source identity, seeds exact child HTML, and generates fresh remote-safe inverse cycles', async t => {
  const f = fixture(t)
  const prepared = await prepareSharedWritingSplit(f.owner, f.identity, {
    sourceHtml: '<p>Alpha beta</p>', beforeHtml: '<p>Alpha </p>', afterHtml: '<p>beta</p>'
  }, 'current-hash')
  assert.equal(f.owner.html, '<p>Alpha beta</p>')
  assert.equal(prepared.sharedSplit.itemId, 'source')
  assert.equal(prepared.expectedHash, 'current-hash')
  f.host.load('child', decode(prepared.sharedSplit.createdState))
  assert.equal(f.host.project('child'), '<p>beta</p>')
  Y.applyUpdate(f.server, decode(prepared.sharedSplit.retainedUpdate))
  prepared.applied()
  assert.equal(f.owner.html, '<p>Alpha </p>')
  f.server.getText('prose').insert(0, 'Peer ')
  f.owner.receive(Y.encodeStateAsUpdate(f.server))
  const firstChild = prepared.sharedSplit.createdItemId
  for (let round = 0; round < 2; round++) {
    const undo = await prepared.prepareUndo()
    const retry = await prepared.prepareUndo()
    assert.equal(retry.update, undo.update)
    Y.applyUpdate(f.server, decode(undo.update))
    prepared.appliedInverse('undo')
    assert.equal(f.owner.html, '<p>Peer Alpha beta</p>')
    const redo = await prepared.prepareRedo()
    assert.notEqual(redo.createdItemId, firstChild)
    Y.applyUpdate(f.server, decode(redo.update))
    prepared.appliedInverse('redo')
    assert.equal(f.owner.html, '<p>Peer Alpha </p>')
  }
  prepared.dispose()
})

test('unsupported child encoding aborts before source mutation and source leases reject concurrent local edits', async t => {
  const f = fixture(t)
  await assert.rejects(prepareSharedWritingSplit(f.owner, f.identity, {
    sourceHtml: f.owner.html, beforeHtml: '<p>Alpha </p>', afterHtml: '<p><span></span>beta</p>'
  }, 'hash'), /without changing|canonical/i)
  assert.equal(f.owner.html, '<p>Alpha beta</p>')
  const prepared = await prepareSharedWritingSplit(f.owner, f.identity, {
    sourceHtml: f.owner.html, beforeHtml: '<p>Alpha </p>', afterHtml: '<p>beta</p>'
  }, 'hash')
  assert.throws(() => f.owner.transact(prose => prose.insert(0, 'late')), /reserved/i)
  prepared.rejected()
  f.owner.transact(prose => prose.insert(0, 'allowed '))
  assert.equal(f.owner.html, '<p>allowed Alpha beta</p>')
  prepared.dispose()
})

test('shared split receipt retries reacquire leases and keep inverse bytes stable after a lost acknowledgement', async t => {
  const f = fixture(t)
  const prepared = await prepareSharedWritingSplit(f.owner, f.identity, {
    sourceHtml: f.owner.html, beforeHtml: '<p>Alpha </p>', afterHtml: '<p>beta</p>'
  }, 'hash')
  prepared.rejected()
  await prepared.prepareRetry()
  Y.applyUpdate(f.server, decode(prepared.sharedSplit.retainedUpdate))
  prepared.applied()
  prepared.applied()
  const undo = await prepared.prepareUndo()
  Y.applyUpdate(f.server, decode(undo.update))
  prepared.rejected()
  f.server.getText('prose').insert(0, 'Peer ')
  f.owner.receive(Y.encodeStateAsUpdate(f.server))
  const retry = await prepared.prepareUndo()
  assert.deepEqual(retry, undo)
  prepared.appliedInverse('undo')
  prepared.appliedInverse('undo')
  assert.equal(f.owner.html, '<p>Peer Alpha beta</p>')
  prepared.dispose()
})

test('redo transfers the retained child document and its existing undo history to the new shared channel', async t => {
  const f = fixture(t)
  let child
  let oldWrites = 0, newWrites = 0
  const oldServer = new Y.Doc(), newServer = new Y.Doc()
  const prepared = await prepareSharedWritingSplit(f.owner, f.identity, {
    sourceHtml: f.owner.html, beforeHtml: '<p>Alpha </p>', afterHtml: '<p>beta</p>'
  }, 'hash', {
    find: () => child,
    transfer: (_previous, next) => child.rebindConnection({ read: async () => Y.encodeStateAsUpdate(newServer), subscribe: () => () => {},
      write: async update => { newWrites++; Y.applyUpdate(newServer, update) } }, decode(next.state))
  })
  const childState = decode(prepared.sharedSplit.createdState)
  Y.applyUpdate(oldServer, childState)
  child = new SharedSceneSession(f.environment, childState, {
    read: async () => Y.encodeStateAsUpdate(oldServer), subscribe: () => () => {},
    write: async update => { oldWrites++; Y.applyUpdate(oldServer, update) }
  })
  const childDocument = child.doc
  Y.applyUpdate(f.server, decode(prepared.sharedSplit.retainedUpdate))
  prepared.applied()
  child.transact(prose => prose.insert(0, 'edited '))
  await child.flush()
  child.undo()
  await child.flush()
  const undo = await prepared.prepareUndo()
  Y.applyUpdate(f.server, decode(undo.update))
  prepared.appliedInverse('undo')
  const redo = await prepared.prepareRedo()
  Y.applyUpdate(newServer, decode(redo.createdState))
  Y.applyUpdate(f.server, decode(redo.update))
  prepared.appliedInverse('redo')
  const previousWrites = oldWrites
  child.redo()
  await child.flush()
  assert.equal(child.doc, childDocument)
  assert.equal(newServer.getText('prose').toString(), 'edited beta\n')
  assert.equal(oldWrites, previousWrites)
  assert.equal(newWrites, 1)
  prepared.dispose()
  await child.close()
  oldServer.destroy()
  newServer.destroy()
})
