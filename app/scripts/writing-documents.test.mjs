import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'
import * as pendingWrites from '../src/renderer/src/stores/pendingWrites.ts'

const observerErrors = []

const { WritingDocumentRegistry, createWritingRpcTransport, getWritingDocumentRegistry, closeWritingDocumentRegistry } = loadRendererSource('src/stores/writingDocuments.ts', {
  './pendingWrites': pendingWrites
}, { crypto, structuredClone, reportError: error => observerErrors.push(error) })

const context = { workspaceId: 'workspace', workspaceEpoch: 2, bookId: 'book', draftId: 'draft' }
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const snapshot = { html: '<p>Original</p>', hash: 'original' }
const ownership = { sourceId: 'pane-one', focusGeneration: 4, activationGeneration: 1 }
const turn = () => new Promise(resolve => setImmediate(resolve))
function transaction(document, afterHtml = '<p>Changed</p>') {
  return { id: crypto.randomUUID(), context, origin: 'writer', kind: 'input', changes: [{ ref, expectedRevision: document.revision, beforeHtml: document.html, afterHtml }], annotationChanges: [], beforeSelection: null, afterSelection: null }
}
async function registry(options = {}) {
  const reads = [], commits = [], activations = []
  const transport = {
    read: async reference => { reads.push(reference); return snapshot },
    activate: async (reference, capturedContext, capturedOwner) => { activations.push({ reference, capturedContext, capturedOwner }); return true },
    commit: async request => { commits.push(request); return { status: 'committed', operationId: 'operation', hashes: [...request.changes, ...request.annotationChanges].map(change => ({ ref: change.ref, hash: 'saved' })) } },
    ...options.transport
  }
  return { owner: new WritingDocumentRegistry({ context, isCurrent: () => true, ...options, transport }), reads, commits, activations }
}

test('two panes share a passive read and canonical HTML with independent subscribers', async () => {
  const { owner, reads, activations, commits } = await registry()
  const first = [], second = []
  const releaseFirst = owner.subscribe(ref, document => first.push(document.html))
  const releaseSecond = owner.subscribe(ref, document => second.push(document.html))
  const [a, b] = await Promise.all([owner.read(ref), owner.read(ref)])
  assert.deepEqual(a, b)
  assert.equal(reads.length, 1)
  assert.equal(activations.length, 0)
  owner.apply(transaction(a))
  releaseFirst()
  owner.apply(transaction(owner.capture()[0], '<p>Again</p>'))
  assert.deepEqual(first, [snapshot.html, '<p>Changed</p>'])
  assert.deepEqual(second, [snapshot.html, '<p>Changed</p>', '<p>Again</p>'])
  await owner.activate(ref, ownership)
  assert.equal(activations.length, 1)
  assert.deepEqual(structuredClone(activations[0].capturedOwner), ownership)
  await owner.flush()
  assert.equal(commits.length, 1)
  assert.equal(owner.capture()[0].html, '<p>Again</p>')
  releaseSecond()
  await owner.close()
})

test('full identities isolate equal IDs and reject foreign references', async () => {
  const { owner } = await registry()
  await owner.read(ref)
  await assert.rejects(owner.read({ ...ref, draftId: 'other' }), /context/)
  const other = await registry({ context: { ...context, draftId: 'other' } })
  await other.owner.read({ ...ref, draftId: 'other' })
  assert.equal(other.owner.capture()[0].draftId, 'other')
  await owner.read({ ...ref, chapterGuid: 'second' })
  assert.throws(() => owner.subscribe('scene', () => {}), /ambiguous/)
  await owner.close()
  await other.owner.close()
})

test('a snapshot owns its immutable shared identity and supports direct lookup', async () => {
  const identity = { sessionId: 'session', itemId: 'item', state: 'state' }
  const { owner } = await registry({ transport: { read: async () => ({ ...snapshot, shared: identity }) } })
  assert.equal(owner.getSnapshot(ref), undefined)
  const loaded = await owner.read(ref)
  identity.itemId = 'other'
  assert.equal(loaded.shared.itemId, 'item')
  assert.equal(Object.isFrozen(loaded.shared), true)
  assert.equal(owner.getSnapshot(ref), loaded)
  await owner.close()
})

test('compound documents prevalidate all books and notify only after every mutation', async () => {
  const first = await registry()
  const otherContext = { ...context, bookId: 'other-book' }
  const otherRef = { ...ref, bookId: otherContext.bookId }
  const second = await registry({ context: otherContext })
  const a = await first.owner.read(ref)
  const b = await second.owner.read(otherRef)
  const firstTx = transaction(a)
  const secondTx = { ...transaction(b), context: otherContext, changes: [{ ...transaction(b).changes[0], ref: otherRef }] }
  assert.throws(() => WritingDocumentRegistry.applyBatch([
    { registry: first.owner, transaction: firstTx },
    { registry: second.owner, transaction: { ...secondTx, changes: [{ ...secondTx.changes[0], expectedRevision: 99 }] } }
  ]), /revision/)
  assert.equal(first.owner.getSnapshot(ref).html, snapshot.html)
  const observed = []
  first.owner.subscribe(ref, () => observed.push(second.owner.getSnapshot(otherRef).html))
  WritingDocumentRegistry.applyBatch([
    { registry: first.owner, transaction: firstTx },
    { registry: second.owner, transaction: secondTx }
  ])
  assert.deepEqual(observed, [snapshot.html, '<p>Changed</p>'])
  await first.owner.close()
  await second.owner.close()
})

test('observer errors do not turn committed changes into rejected transactions', async () => {
  const { owner } = await registry()
  const original = await owner.read(ref)
  const problem = new Error('Observer failed')
  let observed = ''
  owner.subscribe(ref, document => { if (document.revision) throw problem })
  owner.subscribe(ref, document => { observed = document.html })
  assert.doesNotThrow(() => owner.apply(transaction(original)))
  assert.equal(observed, '<p>Changed</p>')
  assert.equal(observerErrors.at(-1), problem)
  await owner.close()
})

test('compound reservation finishes prior transport before preparing its retained diff', async () => {
  let finish
  const { owner, commits } = await registry({ transport: { commit: request => {
    commits.push(request)
    return new Promise(resolve => { finish = resolve })
  } } })
  const original = await owner.read(ref)
  owner.apply(transaction(original, '<p>First save</p>'))
  const pending = owner.flush()
  await turn()
  owner.apply(transaction(owner.getSnapshot(ref), '<p>Compound edit</p>'))
  let compoundFlushes = 0
  const release = owner.reserveCommit({ flush: async () => { compoundFlushes++ } })
  await owner.flush()
  assert.equal(compoundFlushes, 1)
  assert.throws(() => owner.prepareCommit('compound-id'), /progress/)
  finish({ status: 'committed', operationId: 'first', hashes: [{ ref, hash: 'first-hash' }] })
  await pending
  await owner.waitForCommit()
  assert.equal(commits.length, 1)
  const compound = owner.prepareCommit('compound-id')
  assert.equal(compound.changes[0].beforeHtml, '<p>First save</p>')
  assert.equal(compound.changes[0].expectedHash, 'first-hash')
  owner.apply(transaction(owner.getSnapshot(ref), '<p>Later typing</p>'))
  owner.acknowledgeCommit(compound, { status: 'committed', operationId: 'compound', hashes: [{ ref, hash: 'compound-hash' }] })
  assert.equal(owner.getSnapshot(ref).html, '<p>Later typing</p>')
  assert.equal(owner.isDirty, true)
  release()
  const closed = owner.close()
  await turn()
  finish({ status: 'committed', operationId: 'last', hashes: [{ ref, hash: 'last-hash' }] })
  await closed
})

test('a reserved compound retry settles an uncertain prior receipt with its original ID', async () => {
  let fail = true
  const { owner, commits } = await registry({ transport: { commit: async request => {
    commits.push(request)
    if (fail) throw new Error('Lost response')
    return { status: 'committed', operationId: request.transactionId, hashes: [{ ref, hash: 'acknowledged' }] }
  } } })
  owner.apply(transaction(await owner.read(ref)))
  await assert.rejects(owner.flush(), /Lost response/)
  const release = owner.reserveCommit({ flush: async () => {} })
  fail = false
  await owner.waitForCommit()
  assert.equal(commits[1].transactionId, commits[0].transactionId)
  assert.equal(owner.prepareCommit('next').changes.length, 0)
  release()
  await owner.close()
})

test('draft switch rejects in-flight reads without publishing stale content', async () => {
  let completeRead
  let current = true
  const { owner } = await registry({ isCurrent: () => current, transport: { read: () => new Promise(resolve => { completeRead = resolve }) } })
  let notifications = 0
  owner.subscribe(ref, () => notifications++)
  const read = owner.read(ref)
  await turn()
  current = false
  completeRead(snapshot)
  await assert.rejects(read, /context/)
  assert.equal(owner.capture().length, 0)
  assert.equal(notifications, 0)
  current = true
  await owner.close()
})

test('annotations retain exact records and validate before mutation', async () => {
  const before = { comments: [{ id: 'same-id', anchorText: 'Original', text: 'Comment', resolved: false }], footnotes: [{ id: 'same-id', number: 1, text: 'Footnote' }] }
  const after = { comments: [{ ...before.comments[0], resolved: true }], footnotes: [] }
  const { owner, commits } = await registry({ transport: { read: async () => ({ ...snapshot, annotations: before }) } })
  const original = await owner.read(ref)
  assert.deepEqual(owner.getAnnotations(ref), before)
  const notifications = []
  owner.subscribe(ref, document => notifications.push(document.revision))
  const tx = { ...transaction(original), changes: [], annotationChanges: [{ ref, before, after }] }
  owner.apply(tx)
  assert.deepEqual(owner.getAnnotations(ref), after)
  assert.deepEqual(notifications, [0, 1])
  assert.throws(() => owner.apply(tx), /annotation/)
  await owner.flush()
  assert.equal(commits[0].annotationChanges.length, 1)
  assert.deepEqual(commits[0].annotationChanges[0].after, after)
  await owner.close()
})

test('annotation validation ignores object key insertion order and rejects duplicate scene changes', async () => {
  const before = { comments: [{ id: 'id', anchorText: 'text', text: 'comment', resolved: false }], footnotes: [] }
  const { owner } = await registry({ transport: { read: async () => ({ ...snapshot, annotations: before }) } })
  const document = await owner.read(ref)
  const annotation = { ref, before: { footnotes: [], comments: [{ text: 'comment', resolved: false, id: 'id', anchorText: 'text' }] }, after: { comments: [], footnotes: [] } }
  const tx = { ...transaction(document), changes: [], annotationChanges: [annotation] }
  assert.throws(() => owner.apply({ ...tx, annotationChanges: [annotation, annotation] }), /Duplicate/)
  assert.equal(owner.getAnnotations(ref).comments.length, 1)
  owner.apply(tx)
  await owner.close()
})

test('incomplete acknowledgements and conflicts retain the document for explicit retry', async () => {
  for (const result of [{ status: 'committed', operationId: 'partial', hashes: [] }, { status: 'conflict', conflicts: [{ ref, hash: 'changed-elsewhere' }] }]) {
    let fail = true
    const { owner } = await registry({ transport: { commit: async () => fail ? result : { status: 'committed', operationId: 'saved', hashes: [{ ref, hash: 'saved' }] } } })
    owner.apply(transaction(await owner.read(ref)))
    await assert.rejects(owner.close(), /incomplete|writing.conflict/)
    assert.equal(owner.isDirty, true)
    assert.equal(owner.capture()[0].html, '<p>Changed</p>')
    fail = false
    await owner.close()
  }
})

test('one callback subscribed by two projections survives either projection releasing it', async () => {
  const { owner } = await registry()
  const received = []
  const listener = document => received.push(document.html)
  const first = owner.subscribe(ref, listener)
  const second = owner.subscribe(ref, listener)
  const document = await owner.read(ref)
  first()
  owner.apply(transaction(document))
  assert.deepEqual(received, [snapshot.html, '<p>Changed</p>'])
  second()
  await owner.close()
})

test('retry preserves the recoverable transaction ID and full expected hashes', async () => {
  const requests = []
  const { owner } = await registry({ transport: { commit: async request => {
    requests.push(request)
    return requests.length === 1 ? { status: 'retryable', operationId: 'operation', errorCode: 'writing.retry' } :
      { status: 'committed', operationId: 'operation', hashes: [{ ref, hash: 'saved' }] }
  } } })
  owner.apply(transaction(await owner.read(ref)))
  await assert.rejects(owner.flush(), /writing.retry/)
  await owner.flush()
  assert.equal(requests[0].transactionId, requests[1].transactionId)
  assert.equal(requests[0].expectedEpoch, 2)
  assert.equal(requests[0].changes[0].expectedHash, 'original')
  await owner.close()
})

test('RPC adapter sends explicit references and focused activation ownership', async () => {
  const calls = []
  const transport = createWritingRpcTransport(async (method, params) => { calls.push({ method, params }); return true })
  await transport.read(ref)
  await transport.activate(ref, context, ownership)
  await transport.commit({ transactionId: 'transaction', expectedEpoch: 2, changes: [], annotationChanges: [] })
  assert.deepEqual(structuredClone(calls[0]), { method: 'scenes/readPassive', params: ['book', 'draft', 'chapter', 'scene'] })
  assert.deepEqual(structuredClone(calls[1]), { method: 'scenes/activate', params: ['book', 'draft', 'chapter', 'scene', 2, 'pane-one', 4, 1] })
  assert.equal(calls[2].method, 'writing/commit')
})

test('the context factory retains one owner across independent projections', async () => {
  const options = { context: { ...context, workspaceId: 'factory' }, isCurrent: () => true, transport: { read: async () => snapshot } }
  const first = getWritingDocumentRegistry(options)
  assert.equal(first, getWritingDocumentRegistry(options))
  await first.read(ref)
  await closeWritingDocumentRegistry(options.context)
  const next = getWritingDocumentRegistry(options)
  assert.notEqual(first, next)
  await closeWritingDocumentRegistry(options.context)
})

test('transactions validate every revision before publishing any scene', async () => {
  const { owner } = await registry()
  const original = await owner.read(ref)
  const bad = transaction(original)
  bad.changes.push({ ...bad.changes[0], ref: { ...ref, sceneId: 'missing' } })
  assert.throws(() => owner.apply(bad), /loaded/)
  assert.equal(owner.capture()[0].html, snapshot.html)
  assert.throws(() => owner.apply({ ...transaction(original), context: { ...context, workspaceEpoch: 1 } }), /context/)
  await owner.close()
})

test('failed close captures live changes and retains dirty state for retry', async () => {
  let fail = true
  const { owner } = await registry({ transport: { commit: async request => fail ? { status: 'retryable', operationId: 'retained', errorCode: 'writing.retry' } : { status: 'committed', operationId: 'retained', hashes: request.changes.map(change => ({ ref: change.ref, hash: 'saved' })) } } })
  const original = await owner.read(ref)
  const release = owner.registerCapture(() => {
    if (owner.capture()[0].html === original.html) owner.apply(transaction(original))
  })
  await assert.rejects(owner.close(), /writing.retry/)
  assert.equal(owner.capture()[0].html, '<p>Changed</p>')
  assert.equal(owner.isDirty, true)
  fail = false
  await owner.close()
  assert.equal(owner.isDirty, false)
  release()
})

test('one pending write owner flushes both panes and preserves edits during transport', async () => {
  const { flushPendingWrites } = pendingWrites
  let finish
  const requests = []
  const { owner } = await registry({ transport: { commit: request => {
    requests.push(request)
    if (requests.length === 1) return new Promise(resolve => { finish = () => resolve({ status: 'committed', operationId: 'first', hashes: [{ ref, hash: 'first' }] }) })
    return Promise.resolve({ status: 'committed', operationId: 'second', hashes: [{ ref, hash: 'second' }] })
  } } })
  owner.subscribe(ref, () => {})
  owner.subscribe(ref, () => {})
  owner.apply(transaction(await owner.read(ref)))
  const flush = flushPendingWrites()
  await turn()
  owner.apply(transaction(owner.capture()[0], '<p>Latest</p>'))
  finish()
  await flush
  assert.equal(requests.length, 2)
  assert.equal(requests[1].changes[0].beforeHtml, '<p>Changed</p>')
  assert.equal(requests[1].changes[0].expectedHash, 'first')
  assert.equal(owner.isDirty, false)
  await owner.close()
})
