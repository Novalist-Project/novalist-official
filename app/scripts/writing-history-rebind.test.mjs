import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const result = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/stores/writingPersistence'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { WritingDocumentRegistry, acceptWritingTransaction, acceptWritingBatch, getWritingHistory, rebindWritingHistory, recordExternalWritingTransaction, disposeWritingHistories, reserveWritingBatch } = module.exports
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const context = { workspaceId: 'workspace', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
const transaction = (registry, beforeHtml, afterHtml) => ({ id: crypto.randomUUID(), context: registry.context, origin: 'writer', kind: 'input', changes: [{ ref, expectedRevision: registry.getSnapshot(ref).revision, beforeHtml, afterHtml }], annotationChanges: [], beforeSelection: null, afterSelection: null })

function registry(epoch, html, reference = ref) {
  return new WritingDocumentRegistry({ context: { ...context, bookId: reference.bookId, draftId: reference.draftId, workspaceEpoch: epoch }, isCurrent: () => true, transport: {
    read: async () => ({ html, hash: 'hash', annotations: { comments: [], footnotes: [] } }), activate: async () => true,
    commit: async request => ({ status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
  } })
}

test('prose history survives an epoch replacement and a complete-reference chapter move', async () => {
  const original = registry(1, '<p>before</p>')
  await original.read(ref)
  acceptWritingTransaction(original, transaction(original, '<p>before</p>', '<p>after</p>'))
  await original.flush()
  const moved = { ...ref, chapterGuid: 'new-chapter' }
  const replacement = registry(2, '<p>after</p>', moved)
  await replacement.read(moved)
  rebindWritingHistory(original, replacement, [{ before: ref, after: moved, expectedHtml: '<p>after</p>' }])
  assert.equal(getWritingHistory(original), getWritingHistory(replacement))
  await original.close()
  assert.equal((await getWritingHistory(replacement).undo()).status, 'applied')
  assert.equal(replacement.getSnapshot(moved).html, '<p>before</p>')
  assert.equal((await getWritingHistory(replacement).redo()).status, 'applied')
  assert.equal(replacement.getSnapshot(moved).html, '<p>after</p>')
  await replacement.close()
  disposeWritingHistories(context.workspaceId)
})

test('rebinding the other book updates the initiating book history and workspace disposal releases retained callbacks', async () => {
  const otherRef = { ...ref, bookId: 'other-book' }
  const original = registry(1, '<p>before</p>')
  const other = registry(1, '<p>before</p>', otherRef)
  await Promise.all([original.read(ref), other.read(otherRef)])
  const commit = async request => ({ status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
  reserveWritingBatch([original, other], commit)
  acceptWritingBatch(original, [original, other].map((owner, index) => ({ registry: owner, transaction: {
    ...transaction(original, '<p>before</p>', '<p>after</p>'), context: owner.context,
    changes: [{ ref: index ? otherRef : ref, expectedRevision: 0, beforeHtml: '<p>before</p>', afterHtml: '<p>after</p>' }]
  } })))
  await original.flush()
  const next = registry(2, '<p>after</p>')
  const nextOther = registry(2, '<p>after</p>', otherRef)
  await Promise.all([next.read(ref), nextOther.read(otherRef)])
  rebindWritingHistory(other, nextOther)
  rebindWritingHistory(original, next)
  await Promise.all([original.close(), other.close()])
  reserveWritingBatch([next, nextOther], commit)
  assert.equal((await getWritingHistory(next).undo()).status, 'applied')
  assert.equal(next.getSnapshot(ref).html, '<p>before</p>')
  assert.equal(nextOther.getSnapshot(otherRef).html, '<p>before</p>')
  let released = false
  recordExternalWritingTransaction(next, { ...transaction(next, '', ''), changes: [] }, {
    undo: async () => ({ status: 'applied' }), redo: async () => ({ status: 'applied' }), dispose: () => { released = true }
  })
  const history = getWritingHistory(next)
  disposeWritingHistories(context.workspaceId)
  assert.equal(released, true)
  assert.equal((await history.undo()).status, 'blocked')
  assert.notEqual(getWritingHistory(next), history)
  await Promise.all([next.close(), nextOther.close()])
  disposeWritingHistories(context.workspaceId)
})

test('external inverse callbacks serialize and block new acceptance before model mutation', async () => {
  const owner = registry(1, '<p>before</p>')
  await owner.read(ref)
  let release
  const calls = []
  recordExternalWritingTransaction(owner, { ...transaction(owner, '', ''), changes: [] }, {
    undo: async () => { calls.push('undo'); await new Promise(resolve => { release = resolve }); return { status: 'applied' } },
    redo: async () => { calls.push('redo'); return { status: 'applied' } }
  })
  const undo = getWritingHistory(owner).undo()
  await Promise.resolve()
  assert.throws(() => acceptWritingTransaction(owner, transaction(owner, '<p>before</p>', '<p>lost</p>')), /history/i)
  assert.equal(owner.getSnapshot(ref).html, '<p>before</p>')
  const redo = getWritingHistory(owner).redo()
  release()
  assert.equal((await undo).status, 'applied')
  assert.equal((await redo).status, 'applied')
  assert.deepEqual(calls, ['undo', 'redo'])
  await owner.close()
  disposeWritingHistories(context.workspaceId)
})
