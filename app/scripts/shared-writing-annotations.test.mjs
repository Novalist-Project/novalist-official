import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const result = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/collaboration/sharedWritingAnnotations'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/collaboration/SharedWritingHistory'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { WritingDocumentRegistry, SharedWritingAnnotations, mergeSharedAnnotations, SharedWritingHistory, acceptSharedWritingBatch, getWritingHistory } = module.exports
const context = { workspaceId: 'workspace', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const comment = (id, text) => ({ id, text, anchorText: id, resolved: false, createdAt: '2026-11-01T00:00:00Z', author: 'Writer', isTodo: true, verdict: null, replies: [{ id: 'reply', author: 'Peer', text: 'Reply', createdAt: '2026-11-02T00:00:00Z' }] })
const annotations = comments => ({ comments, footnotes: [] })

async function fixture(t, initial) {
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
    read: async () => ({ html: '<p>Shared</p>', hash: 'hash', shared: { sessionId: 'session', itemId: 'item', state: '' }, annotations: initial }),
    activate: async () => true, commit: async () => assert.fail('shared annotations must not use local-file persistence')
  } })
  await registry.read(ref)
  t.after(() => registry.close())
  return registry
}

test('touched-record inverse preserves unrelated remote comments and complete restored provenance', async t => {
  const original = comment('local', 'Before')
  const before = annotations([original])
  const registry = await fixture(t, before)
  let server = structuredClone(before)
  const metadata = new SharedWritingAnnotations(async request => {
    server = mergeSharedAnnotations(server, request.changes[0])
    return { status: 'committed', operationId: request.transactionId, annotations: [{ ref, annotations: server }] }
  })
  const action = metadata.accept('delete', [{ registry, change: { ref, before, after: annotations([]) } }])
  await metadata.flush()
  server.comments.push(comment('remote', 'Peer contribution'))
  metadata.receive(registry, ref, server)
  action.undo()
  await metadata.flush()
  assert.deepEqual(registry.getAnnotations(ref).comments, [comment('remote', 'Peer contribution'), original])
  action.redo()
  await metadata.flush()
  assert.deepEqual(server.comments, [comment('remote', 'Peer contribution')])
  await metadata.close()
})

test('failed metadata sends retain operation id and late acknowledgements rebase newer edits', async t => {
  const before = annotations([])
  const registry = await fixture(t, before)
  const calls = []
  let release
  let server = before
  const metadata = new SharedWritingAnnotations(async request => {
    calls.push(request)
    if (calls.length === 1) return { status: 'retryable', operationId: request.transactionId, errorCode: 'writing.retry' }
    if (calls.length === 2) await new Promise(resolve => { release = resolve })
    server = mergeSharedAnnotations(server, request.changes[0])
    return { status: 'committed', operationId: request.transactionId, annotations: [{ ref, annotations: server }] }
  })
  const added = annotations([comment('local', 'First')])
  metadata.accept('first', [{ registry, change: { ref, before, after: added } }])
  await assert.rejects(metadata.flush())
  assert.equal(metadata.pendingTransactionId, 'first')
  const saving = metadata.flush()
  await Promise.resolve()
  const latest = annotations([comment('local', 'Newest')])
  metadata.accept('second', [{ registry, change: { ref, before: added, after: latest } }])
  release()
  await saving
  assert.equal(calls[0].transactionId, calls[1].transactionId)
  assert.equal(registry.getAnnotations(ref).comments[0].text, 'Newest')
  assert.equal(server.comments[0].text, 'Newest')
  await metadata.close()
})

test('concurrent changes to the same comment block an inverse before any metadata mutation', async t => {
  const before = annotations([comment('local', 'Before')])
  const registry = await fixture(t, before)
  const metadata = new SharedWritingAnnotations(async request => ({ status: 'committed', operationId: request.transactionId, annotations: [{ ref, annotations: request.changes[0].after }] }))
  const changed = annotations([comment('local', 'Local edit')])
  const action = metadata.accept('edit', [{ registry, change: { ref, before, after: changed } }])
  await metadata.flush()
  metadata.receive(registry, ref, annotations([comment('local', 'Peer edit')]))
  assert.throws(() => action.undo(), /conflict/i)
  assert.equal(registry.getAnnotations(ref).comments[0].text, 'Peer edit')
  await metadata.close()
})

test('backend recovery rebases pending annotation epoch while retaining its stable request', async t => {
  const before = annotations([])
  const registry = await fixture(t, before)
  const calls = []
  const metadata = new SharedWritingAnnotations(async request => {
    calls.push(structuredClone(request))
    if (calls.length === 1) throw new Error('Disconnected')
    return { status: 'committed', operationId: request.transactionId,
      annotations: [{ ref, annotations: request.changes[0].after }] }
  })
  metadata.accept('retained', [{ registry, change: { ref, before, after: annotations([comment('a', 'Local')]) } }])
  await assert.rejects(metadata.flush(), /Disconnected/)
  const recovery = await registry.prepareRecovery()
  recovery.apply({ ...context, workspaceEpoch: 0 })
  recovery.release()
  await metadata.rebaseRecovery(0)
  await metadata.flush()
  assert.equal(calls[1].transactionId, calls[0].transactionId)
  assert.deepEqual(calls[1].changes, calls[0].changes)
  assert.equal(calls[1].expectedEpoch, 0)
  await metadata.close()
})

test('annotation-only shared actions use the retained mixed timeline and never local-file persistence', async t => {
  const original = comment('local', 'Original')
  const before = annotations([original])
  const registry = await fixture(t, before)
  let server = before
  const metadata = new SharedWritingAnnotations(async request => {
    server = mergeSharedAnnotations(server, request.changes[0])
    return { status: 'committed', operationId: request.transactionId, annotations: [{ ref, annotations: server }] }
  })
  const sharedHistory = new SharedWritingHistory()
  acceptSharedWritingBatch(registry, [{ registry, transaction: {
    id: 'annotation', context, origin: 'writer', kind: 'input', changes: [],
    annotationChanges: [{ ref, before, after: annotations([]) }], beforeSelection: null, afterSelection: null
  } }], sharedHistory, new Map(), { annotations: metadata })
  await metadata.flush()
  server.comments.push(comment('peer', 'Keep me'))
  metadata.receive(registry, ref, server)
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  await metadata.flush()
  assert.deepEqual(server.comments, [comment('peer', 'Keep me'), original])
  assert.equal((await getWritingHistory(registry).redo()).status, 'applied')
  await metadata.flush()
  assert.deepEqual(server.comments, [comment('peer', 'Keep me')])
  sharedHistory.dispose()
  await metadata.close()
})

test('passive refresh ignores older responses and waits for pending metadata acknowledgements', async t => {
  const before = annotations([])
  const registry = await fixture(t, before)
  const metadata = new SharedWritingAnnotations(async request => ({ status: 'committed', operationId: request.transactionId, annotations: [{ ref, annotations: request.changes[0].after }] }))
  const after = annotations([comment('local', 'Saved')])
  metadata.accept('pending', [{ registry, change: { ref, before, after } }])
  let reads = 0
  await metadata.refresh(registry, ref, async () => { reads++; return after })
  assert.equal(reads, 0)
  await metadata.flush()
  let first, second
  const older = metadata.refresh(registry, ref, () => new Promise(resolve => { first = resolve }))
  const newer = metadata.refresh(registry, ref, () => new Promise(resolve => { second = resolve }))
  first(annotations([comment('local', 'Older peer data')]))
  await older
  assert.equal(registry.getAnnotations(ref).comments[0].text, 'Saved')
  second(annotations([comment('local', 'Latest peer data')]))
  await newer
  assert.equal(registry.getAnnotations(ref).comments[0].text, 'Latest peer data')
  await metadata.close()
})
