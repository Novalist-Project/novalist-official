import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const result = await build({ stdin: { contents: "export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/renderer/src/collaboration/sharedWritingGroup'; export * from './src/shared/ProseDocumentHost'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { SharedSceneSession, prepareSharedWritingGroup, ProseDocumentHost } = module.exports
const decode = value => Uint8Array.from(Buffer.from(value, 'base64'))

async function fixture(t) {
  const dom = new JSDOM('<body></body>')
  const document = dom.window.document
  const environment = { document, sanitizeSceneFragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content }, toDisplayImages() {} }
  const host = new ProseDocumentHost(document, environment)
  const values = ['First', 'Second'].map((text, index) => {
    const state = host.seed(text, `<p>${text}</p>`)
    const server = new Y.Doc()
    Y.applyUpdate(server, state)
    const session = new SharedSceneSession(environment, state, { read: async () => Y.encodeStateAsUpdate(server), subscribe: () => () => {}, write: async update => Y.applyUpdate(server, update) })
    return { server, session, identity: { sessionId: 'session', itemId: text, state: Buffer.from(state).toString('base64') },
      ref: { bookId: `book-${index}`, draftId: 'draft', chapterGuid: 'chapter', sceneId: 'same' } }
  })
  t.after(async () => { for (const value of values) { await value.session.close(); value.server.destroy() }; host.dispose(); dom.window.close() })
  const changes = () => values.map(value => ({ ...value, expectedRevision: value.session.revision,
    beforeHtml: value.session.html, afterHtml: value.session.html.replace('</p>', ' local</p>') }))
  const publish = (intent, inverse = false) => intent.changes.forEach((change, index) => Y.applyUpdate(values[index].server, decode(inverse ? change.inverseUpdate : change.forwardUpdate)))
  return { values, changes, publish }
}

test('serializable shared intent publishes idempotently and compensation preserves remote contributions', async t => {
  const f = await fixture(t)
  const group = await prepareSharedWritingGroup('durable-group', f.changes())
  const intent = JSON.parse(JSON.stringify(group.intent))
  assert.equal(intent.groupId, 'durable-group')
  assert.deepEqual(intent.changes.map(change => change.ref.bookId), ['book-0', 'book-1'])
  assert.equal(f.values[0].session.html, '<p>First</p>')
  f.publish(intent)
  f.publish(intent)
  group.markPublished()
  f.values[0].server.getText('prose').insert(0, 'Peer ')
  f.values[0].session.receive(Y.encodeStateAsUpdate(f.values[0].server))
  f.publish(intent, true)
  group.markRolledBack()
  group.release()
  assert.equal(f.values[0].session.html, '<p>Peer First</p>')
  assert.equal(f.values[1].session.html, '<p>Second</p>')
  group.dispose()
})

test('fresh durable intents support repeated grouped undo redo after shared publication', async t => {
  const f = await fixture(t)
  const group = await prepareSharedWritingGroup('initial', f.changes())
  f.publish(group.intent)
  group.markPublished()
  group.release()
  for (let index = 0; index < 2; index++) {
    const undo = await group.prepareUndo()
    assert.deepEqual(await group.prepareUndo(), undo)
    f.publish(undo)
    group.markPublished()
    group.release()
    assert.equal(f.values[0].session.html, '<p>First</p>')
    const redo = await group.prepareRedo()
    assert.notEqual(redo.groupId, undo.groupId)
    f.publish(redo)
    group.markPublished()
    group.release()
    assert.equal(f.values[1].session.html, '<p>Second local</p>')
  }
  group.dispose()
})

test('compensating a failed undo or redo preserves a retryable chronological history', async t => {
  const f = await fixture(t)
  const group = await prepareSharedWritingGroup('initial', f.changes())
  f.publish(group.intent)
  group.markPublished()
  group.release()
  for (const direction of ['Undo', 'Redo']) {
    const failed = await group[`prepare${direction}`]()
    f.publish(failed)
    f.publish(failed, true)
    group.markRolledBack()
    group.release()
    assert.equal(f.values[0].session.html, direction === 'Undo' ? '<p>First local</p>' : '<p>First</p>')
    const retry = await group[`prepare${direction}`]()
    f.publish(retry)
    group.markPublished()
    group.release()
    assert.equal(f.values[0].session.html, direction === 'Undo' ? '<p>First</p>' : '<p>First local</p>')
  }
  group.dispose()
})

test('an exact-token connection transfer retains a leased document and grouped inverse after backend restart', async t => {
  const f = await fixture(t)
  const group = await prepareSharedWritingGroup('restart', f.changes())
  const owner = f.values[0].session
  const document = owner.doc
  const history = owner.history
  let listener
  let writes = 0
  const connection = { read: async () => Y.encodeStateAsUpdate(f.values[0].server),
    subscribe: callback => { listener = callback; return () => { listener = undefined } },
    write: async update => { writes++; Y.applyUpdate(f.values[0].server, update) } }
  f.publish(group.intent)
  assert.throws(() => owner.rebindExternalConnection('wrong', connection, Y.encodeStateAsUpdate(f.values[0].server)), /reservation/)
  owner.rebindExternalConnection('restart', connection, Y.encodeStateAsUpdate(f.values[0].server))
  assert.equal(owner.doc, document)
  assert.equal(owner.history, history)
  assert.throws(() => owner.transact(prose => prose.insert(0, 'blocked')), /reserved/)
  group.markPublished()
  f.values[0].server.getText('prose').insert(0, 'Peer ')
  listener(Y.encodeStateAsUpdate(f.values[0].server))
  group.release()
  assert.equal(owner.html, '<p>Peer First local</p>')
  const inverse = await group.prepareUndo()
  f.publish(inverse)
  group.markPublished()
  group.release()
  assert.equal(owner.html, '<p>Peer First</p>')
  owner.transact(prose => prose.insert(0, 'New '))
  await owner.flush()
  assert.equal(writes, 1)
  group.dispose()
})
