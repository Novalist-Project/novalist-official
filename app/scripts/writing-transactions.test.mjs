import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const result = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/stores/writingPersistence'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { WritingDocumentRegistry, acceptWritingTransaction, acceptWritingBatch, getWritingHistory, createWritingPersistence, reserveWritingBatch, observeWritingPersistence, scheduleWritingSave } = module.exports
const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
const ref = sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId })

async function fixture(t) {
  let current = true
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => current, transport: {
    read: async reference => ({ html: `<p>${reference.sceneId}</p>`, hash: reference.sceneId, annotations: { comments: [], footnotes: [] } }),
    activate: async () => true,
    commit: async request => ({ status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
  } })
  const scenes = await Promise.all(['one', 'two'].map(id => registry.read(ref(id))))
  t.after(async () => { current = true; await registry.close() })
  return { registry, scenes, expire: () => { current = false } }
}

function transaction(scenes, suffix = '!') {
  return { id: crypto.randomUUID(), context, origin: 'writer', kind: 'replace', changes: scenes.map(scene => ({ ref: ref(scene.sceneId), expectedRevision: scene.revision, expectedHash: scene.hash, beforeHtml: scene.html, afterHtml: scene.html.replace('</p>', `${suffix}</p>`) })), annotationChanges: [], beforeSelection: { anchor: { sceneId: 'one', offset: 0, affinity: 'before' }, focus: { sceneId: 'two', offset: 2, affinity: 'after' } }, afterSelection: null }
}

test('two scenes undo together and history survives a new projection and redo', async t => {
  const { registry, scenes } = await fixture(t)
  const tx = transaction(scenes)
  acceptWritingTransaction(registry, tx)
  const history = getWritingHistory(registry)
  assert.equal(getWritingHistory(registry), history)
  assert.deepEqual(await history.undo(), { status: 'applied', selection: tx.beforeSelection })
  assert.deepEqual(registry.capture().map(scene => scene.html), scenes.map(scene => scene.html))
  assert.equal((await history.redo()).status, 'applied')
  assert.deepEqual(registry.capture().map(scene => scene.html), tx.changes.map(change => change.afterHtml))
})

test('two panes share chronological history and multiple undo redo steps keep revisions valid', async t => {
  const { registry, scenes } = await fixture(t)
  acceptWritingTransaction(registry, transaction([scenes[0]]))
  acceptWritingTransaction(registry, transaction([await registry.read(ref('one'))], '?'))
  const history = getWritingHistory(registry)
  for (let index = 0; index < 2; index++) assert.equal((await history.undo()).status, 'applied')
  assert.equal((await registry.read(ref('one'))).html, '<p>one</p>')
  for (let index = 0; index < 2; index++) assert.equal((await history.redo()).status, 'applied')
  assert.equal((await registry.read(ref('one'))).html, '<p>one!?</p>')
})

test('stale revisions and epochs block the entire inverse without losing history', async t => {
  const { registry, scenes, expire } = await fixture(t)
  acceptWritingTransaction(registry, transaction(scenes))
  registry.apply(transaction([await registry.read(ref('two'))], 'outside'))
  const before = registry.capture()
  assert.equal((await getWritingHistory(registry).undo()).status, 'blocked')
  assert.deepEqual(registry.capture(), before)
  expire()
  assert.equal((await getWritingHistory(registry).undo()).status, 'blocked')
})

test('caller mutation cannot corrupt a retained inverse or selection', async t => {
  const { registry, scenes } = await fixture(t)
  const tx = transaction(scenes)
  acceptWritingTransaction(registry, tx)
  tx.changes[0].beforeHtml = 'wrong'
  tx.beforeSelection.anchor.offset = 77
  const result = await getWritingHistory(registry).undo()
  assert.equal(result.selection.anchor.offset, 0)
  assert.equal((await registry.read(ref('one'))).html, '<p>one</p>')
})

test('compound persistence retains stable operation identity through retry and checks acknowledgements', async () => {
  const calls = []
  const persistence = createWritingPersistence(async request => {
    calls.push(request)
    return calls.length === 1 ? { status: 'retryable', operationId: request.transactionId, errorCode: 'writing.retry' } : { status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: 'saved' })) }
  })
  const tx = transaction([{ ...ref('one'), revision: 0, html: '<p>one</p>', hash: 'one' }])
  assert.equal((await persistence.commit(tx)).status, 'retryable')
  assert.equal(persistence.pendingTransactionId, tx.id)
  assert.equal((await persistence.commit(tx)).status, 'committed')
  assert.equal(calls[0].transactionId, calls[1].transactionId)
  assert.equal(persistence.pendingTransactionId, null)
})

test('cross-book history reserves one compound commit, retries the same id, and retains complete undo references', async t => {
  const registries = ['book', 'other-book'].map(bookId => new WritingDocumentRegistry({
    context: { ...context, bookId }, isCurrent: () => true, transport: {
      read: async () => ({ html: '<p>before</p>', hash: 'before' }), activate: async () => true,
      commit: async () => { assert.fail('a reserved book must not issue an independent save') }
    }
  }))
  const scenes = await Promise.all(registries.map(registry => registry.read({ ...ref('same-scene-id'), bookId: registry.context.bookId })))
  const calls = []
  const commit = async request => {
    calls.push(request)
    return calls.length === 1 ? { status: 'retryable', operationId: request.transactionId, errorCode: 'writing.retry' }
      : { status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) }
  }
  reserveWritingBatch(registries, commit)
  acceptWritingBatch(registries[0], registries.map((registry, index) => ({ registry, transaction: {
    ...transaction([]), context: registry.context, changes: [{ ref: scenes[index], expectedRevision: 0, expectedHash: 'before', beforeHtml: '<p>before</p>', afterHtml: '<p>after</p>' }]
  } })))
  await assert.rejects(registries[0].flush(), /writing.retry/)
  assert.equal(registries.every(registry => registry.isDirty), true)
  await Promise.all(registries.map(registry => registry.flush()))
  assert.equal(calls.length, 2)
  assert.equal(calls[0].transactionId, calls[1].transactionId)
  assert.deepEqual(calls[1].changes.map(change => change.ref.bookId), ['book', 'other-book'])
  reserveWritingBatch(registries, commit)
  assert.equal((await getWritingHistory(registries[0]).undo()).status, 'applied')
  assert.equal(registries.every(registry => registry.getSnapshot(scenes[registries.indexOf(registry)]).html === '<p>before</p>'), true)
  await registries[1].flush()
  assert.equal(calls[2].changes.length, 2)
  t.after(async () => { await Promise.all(registries.map(registry => registry.close())) })
})

test('retained autosave reports failure and a retry without clearing dirty content', async t => {
  let fail = true
  let calls = 0
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
    read: async () => ({ html: '<p>before</p>', hash: 'before' }), activate: async () => true,
    commit: async request => {
      calls++
      return fail ? { status: 'retryable', operationId: request.transactionId, errorCode: 'writing.retry' }
        : { status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) }
    }
  } })
  const statuses = []
  const unsubscribe = observeWritingPersistence(registry, status => statuses.push(status))
  acceptWritingTransaction(registry, transaction([await registry.read(ref('one'))]))
  scheduleWritingSave(registry, 0)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(registry.isDirty, true)
  assert.equal(statuses.at(-1).error.status, 'retryable')
  fail = false
  scheduleWritingSave(registry, 0)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(registry.isDirty, false)
  assert.equal(statuses.at(-1).pending, false)
  assert.equal(calls, 2)
  unsubscribe()
  t.after(() => registry.close())
})
