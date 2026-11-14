import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const bundle = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/stores/writingPersistence'; export * from './src/renderer/src/stores/writingExternalRefresh'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), crypto, structuredClone, console, setTimeout, clearTimeout })
const documents = module.exports
const persistence = module.exports
const context = { workspaceId: 'project', workspaceEpoch: 3, bookId: 'book', draftId: 'draft' }
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
function edit(owner, reference, html) {
  const before = owner.getSnapshot(reference)
  owner.apply({ id: crypto.randomUUID(), context: owner.context, origin: 'pane', kind: 'input',
    changes: [{ ref: reference, expectedRevision: before.revision, beforeHtml: before.html, afterHtml: html }],
    annotationChanges: [], beforeSelection: null, afterSelection: null })
}
async function fixture(options = {}) {
  const disk = new Map(), requests = []
  let current = true
  const transport = {
    read: async reference => disk.get(documents.sceneRefKey(reference)) ?? { html: 'original', hash: 'original' },
    activate: async () => { throw new Error('Background refresh must not activate') },
    commit: async request => { requests.push(request); return { status: 'committed', hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) } },
    ...options.transport
  }
  const owner = new documents.WritingDocumentRegistry({ context, isCurrent: () => current, ...options, transport })
  await owner.read(ref)
  return { owner, disk, requests, transport, expire: () => { current = false } }
}

test('clean offscreen reload notifies both panes and preserves another dirty scene', async () => {
  const { owner, disk, requests } = await fixture()
  const other = { ...ref, sceneId: 'other' }
  await owner.read(other)
  edit(owner, other, 'unsaved other')
  const a = [], b = []
  owner.subscribe(ref, value => a.push(value.html))
  owner.subscribe(ref, value => b.push(value.html))
  disk.set(documents.sceneRefKey(ref), { html: 'disk edit', hash: 'disk hash', annotations: { comments: [], footnotes: [{ id: 'note', number: 1, text: 'external' }] } })
  assert.equal((await owner.refreshFromDisk(ref)).status, 'refreshed')
  assert.deepEqual(a, ['original', 'disk edit'])
  assert.deepEqual(b, a)
  assert.equal(owner.getAnnotations(ref).footnotes[0].text, 'external')
  assert.equal(owner.isDirty, true)
  await owner.flush()
  assert.deepEqual(Array.from(requests[0].changes, change => change.ref.sceneId), ['other'])
})

test('pending DOM capture and edits arriving during passive read become a conflict', async () => {
  const { owner, transport } = await fixture()
  let release
  transport.read = () => new Promise(resolve => { release = resolve })
  let pending = true
  owner.registerCapture(() => { if (pending) { pending = false; edit(owner, ref, 'pending native input') } })
  const read = owner.refreshFromDisk(ref)
  assert.equal(owner.getSnapshot(ref).html, 'pending native input')
  edit(owner, ref, 'newer input')
  release({ html: 'external', hash: 'external' })
  const result = await read
  assert.equal(result.status, 'conflict')
  assert.equal(result.conflict.mine, 'newer input')
  assert.equal(result.conflict.theirs, 'external')
  assert.deepEqual(structuredClone(result.conflict.context), context)
  assert.deepEqual(structuredClone(result.conflict.ref), ref)
  assert.equal(owner.getSnapshot(ref).hash, 'original')
})

test('newer save and obsolete epochs reject a delayed disk read', async () => {
  const { owner, transport, expire } = await fixture()
  let release
  transport.read = () => new Promise(resolve => { release = resolve })
  const first = owner.refreshFromDisk(ref)
  edit(owner, ref, 'new save')
  await owner.flush()
  release({ html: 'stale', hash: 'stale' })
  assert.equal((await first).status, 'unchanged')
  assert.equal(owner.getSnapshot(ref).html, 'new save')
  const next = owner.refreshFromDisk(ref)
  expire()
  release({ html: 'old workspace', hash: 'old' })
  await assert.rejects(next, /context/)
})

test('shared documents never read their stale disk file', async () => {
  let reads = 0
  const { owner } = await fixture({ transport: { read: async () => { reads++; return { html: 'shared', hash: 'shared', shared: { sessionId: 'session', itemId: 'item', state: '' } } } } })
  assert.equal((await owner.refreshFromDisk(ref)).status, 'unchanged')
  assert.equal(reads, 1)
})

test('metadata-only refresh adopts comments with unchanged prose and preserves unsaved text', async () => {
  const before = { comments: [{ id: 'note', anchorText: 'original', text: 'Note', resolved: false,
    createdAt: '2026-01-01', author: 'Writer', isTodo: false, verdict: null, replies: [] }], footnotes: [] }
  let annotations = before
  const { owner } = await fixture({ transport: { read: async () => ({ html: 'original', hash: 'original', annotations }) } })
  edit(owner, ref, 'unsaved original')
  const updates = []
  owner.subscribe(ref, () => updates.push(owner.getAnnotations(ref)))
  annotations = { ...before, comments: [{ ...before.comments[0], isTodo: true,
    replies: [{ id: 'reply', author: 'Reviewer', text: 'Check this', createdAt: '2026-01-02' }] }] }
  assert.equal((await owner.refreshFromDisk(ref)).status, 'refreshed')
  assert.deepEqual(structuredClone(owner.getAnnotations(ref)), annotations)
  assert.equal(owner.getSnapshot(ref).html, 'unsaved original')
  assert.equal(owner.isDirty, true)
  assert.equal(updates.length, 2)
  await owner.flush()
  await owner.close()
})

test('metadata refresh cannot overwrite local annotation changes or newer read results', async () => {
  const initial = { comments: [{ id: 'note', anchorText: 'original', text: 'Original', resolved: false }], footnotes: [] }
  let annotations = initial
  const { owner, transport } = await fixture({ transport: { read: async () => ({ html: 'original', hash: 'original', annotations }) } })
  let complete
  transport.read = () => new Promise(resolve => { complete = resolve })
  const stale = owner.refreshFromDisk(ref)
  const finishStale = complete
  const latest = owner.refreshFromDisk(ref)
  annotations = { ...initial, comments: [{ ...initial.comments[0], text: 'External latest' }] }
  complete({ html: 'original', hash: 'original', annotations })
  assert.equal((await latest).status, 'refreshed')
  finishStale({ html: 'original', hash: 'original', annotations: initial })
  assert.equal((await stale).status, 'unchanged')
  assert.deepEqual(structuredClone(owner.getAnnotations(ref)), annotations)
  const local = { ...annotations, comments: [{ ...annotations.comments[0], text: 'Pending local' }] }
  owner.apply({ id: crypto.randomUUID(), context, origin: 'pane', kind: 'input', changes: [],
    annotationChanges: [{ ref, before: annotations, after: local }], beforeSelection: null, afterSelection: null })
  transport.read = async () => ({ html: 'original', hash: 'original', annotations })
  assert.equal((await owner.refreshFromDisk(ref)).status, 'unchanged')
  annotations = { ...annotations, comments: [{ ...annotations.comments[0], text: 'Another external edit' }] }
  await assert.rejects(owner.refreshFromDisk(ref), /annotationConflict/)
  assert.deepEqual(structuredClone(owner.getAnnotations(ref)), local)
  assert.equal(owner.isDirty, true)
})

test('explicit resolution retires a definitive failed request without losing other dirty content', async () => {
  const { owner, disk, transport, requests } = await fixture()
  const other = { ...ref, sceneId: 'other' }
  await owner.read(other)
  edit(owner, ref, 'mine')
  edit(owner, other, 'other unsaved')
  transport.commit = async request => { requests.push(request); return { status: 'conflict', conflicts: [{ ref, diskHtml: 'theirs', diskHash: 'theirs' }] } }
  await assert.rejects(owner.flush(), /conflict/)
  disk.set(documents.sceneRefKey(ref), { html: 'theirs', hash: 'theirs' })
  const { conflict } = await owner.refreshFromDisk(ref)
  await owner.resolveDiskConflict(conflict, 'chosen', async request => {
    assert.equal(request.expectedDiskHash, 'theirs')
    assert.equal(request.mine, 'mine')
    return { status: 'committed', hashes: [{ ref, hash: 'resolved' }] }
  })
  assert.equal(owner.getSnapshot(ref).html, 'chosen')
  assert.equal(owner.getSnapshot(ref).hash, 'resolved')
  transport.commit = async request => { requests.push(request); return { status: 'committed', hashes: request.changes.map(change => ({ ref: change.ref, hash: 'saved' })) } }
  await owner.flush()
  assert.notEqual(requests[0].transactionId, requests[1].transactionId)
  assert.deepEqual(Array.from(requests[1].changes, change => change.ref.sceneId), ['other'])
})

test('resolution preserves typing during its request and rejects unknown pending outcomes', async () => {
  const { owner, disk, transport } = await fixture()
  edit(owner, ref, 'mine')
  disk.set(documents.sceneRefKey(ref), { html: 'theirs', hash: 'theirs' })
  const { conflict } = await owner.refreshFromDisk(ref)
  let release
  const resolving = owner.resolveDiskConflict(conflict, 'chosen', () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  edit(owner, ref, 'newer typing')
  release({ status: 'committed', hashes: [{ ref, hash: 'resolved' }] })
  await resolving
  assert.equal(owner.getSnapshot(ref).html, 'newer typing')
  assert.equal(owner.getSnapshot(ref).hash, 'resolved')
  transport.commit = async () => ({ status: 'retryable', errorCode: 'unknown' })
  await assert.rejects(owner.flush(), /unknown/)
  await assert.rejects(owner.resolveDiskConflict(conflict, 'discard', async () => { assert.fail('Must not send resolution for uncertain receipt') }), /pending|unknown/)
})

test('a definite compound conflict is retired as one request and all other books remain dirty', async () => {
  const first = await fixture()
  const otherContext = { ...context, bookId: 'other' }
  const otherRef = { ...ref, bookId: 'other' }
  const owner = new documents.WritingDocumentRegistry({ context: otherContext, isCurrent: () => true, transport: first.transport })
  await owner.read(otherRef)
  edit(first.owner, ref, 'mine')
  edit(owner, otherRef, 'other mine')
  const requests = []
  let conflicted = true
  persistence.reserveWritingBatch([first.owner, owner], async request => {
    requests.push(request)
    return conflicted ? { status: 'conflict', conflicts: [{ ref, hash: 'disk' }] }
      : { status: 'committed', hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) }
  })
  await assert.rejects(first.owner.flush(), /conflict/)
  first.disk.set(documents.sceneRefKey(ref), { html: 'theirs', hash: 'disk' })
  const { conflict } = await first.owner.refreshFromDisk(ref)
  await first.owner.resolveDiskConflict(conflict, 'chosen', async () => ({ status: 'committed', hashes: [{ ref, hash: 'resolved' }] }))
  conflicted = false
  await owner.flush()
  assert.notEqual(requests[0].transactionId, requests[1].transactionId)
  assert.equal(requests[1].changes.length, 1)
  assert.equal(requests[1].changes[0].ref.bookId, 'other')
  assert.equal(first.owner.getSnapshot(ref).html, 'chosen')
})

test('a temporarily missing cloud file is never a clean empty replacement', async () => {
  const { owner, disk } = await fixture()
  disk.set(documents.sceneRefKey(ref), { html: '', hash: 'empty', missing: true })
  assert.equal((await owner.refreshFromDisk(ref)).status, 'unchanged')
  assert.equal(owner.getSnapshot(ref).html, 'original')
})

test('an uncertain resolution retries the same receipt and cannot be replaced by autosave', async () => {
  const { owner, disk } = await fixture()
  edit(owner, ref, 'mine')
  disk.set(documents.sceneRefKey(ref), { html: 'theirs', hash: 'theirs' })
  const { conflict } = await owner.refreshFromDisk(ref)
  let sent
  await assert.rejects(owner.resolveDiskConflict(conflict, 'chosen', async request => {
    sent = request
    return { status: 'retryable', errorCode: 'uncertain' }
  }), /uncertain/)
  await assert.rejects(owner.flush(), /pending conflict/)
  await assert.rejects(owner.resolveDiskConflict(conflict, 'different', async () => assert.fail()), /Retry/)
  await owner.resolveDiskConflict(conflict, 'chosen', async request => {
    assert.equal(request.transactionId, sent.transactionId)
    return { status: 'committed', hashes: [{ ref, hash: 'chosen' }] }
  })
  assert.equal(owner.isDirty, false)
})

test('refresh includes offscreen owners in other books but excludes other workspace epochs', async () => {
  const reads = []
  for (const [bookId, workspaceEpoch] of [['book', 3], ['other', 3], ['old', 2]]) {
    const reference = { ...ref, bookId }
    const owner = documents.getWritingDocumentRegistry({ context: { ...context, bookId, workspaceEpoch }, isCurrent: () => true,
      transport: { read: async reference => { reads.push(reference); return { html: `disk ${bookId}`, hash: bookId } }, activate: async () => assert.fail(), commit: async () => assert.fail() } })
    await owner.read(reference)
    if (bookId !== 'old') edit(owner, reference, `mine ${bookId}`)
  }
  reads.length = 0
  assert.equal((await documents.refreshWritingOwners(context)).length, 0)
  assert.deepEqual(Array.from(reads, reference => reference.bookId), ['book', 'other'])
})

test('backend recovery rebases an uncertain resolution receipt while retaining its original dialog', async () => {
  let epoch = context.workspaceEpoch
  const { owner, disk } = await fixture({ isCurrent: captured => captured.workspaceEpoch === epoch })
  edit(owner, ref, 'mine')
  disk.set(documents.sceneRefKey(ref), { html: 'theirs', hash: 'theirs' })
  const { conflict } = await owner.refreshFromDisk(ref)
  let transactionId
  await assert.rejects(owner.resolveDiskConflict(conflict, 'chosen', async request => {
    transactionId = request.transactionId
    throw new Error('Lost reply')
  }), /Lost reply/)
  const recovery = await owner.prepareRecovery()
  epoch = 0
  recovery.apply({ ...context, workspaceEpoch: epoch })
  recovery.release()
  await owner.resolveDiskConflict(conflict, 'chosen', async request => {
    assert.equal(request.transactionId, transactionId)
    assert.equal(request.expectedEpoch, epoch)
    return { status: 'committed', hashes: [{ ref, hash: 'chosen' }] }
  })
  assert.equal(owner.isDirty, false)
  assert.equal(owner.getSnapshot(ref).html, 'chosen')
})

test('late ordinary conflicts include newer typing but retire after their saved base changes', async () => {
  const { owner, disk } = await fixture()
  edit(owner, ref, 'mine')
  disk.set(documents.sceneRefKey(ref), { html: 'theirs', hash: 'theirs' })
  const { conflict } = await owner.refreshFromDisk(ref)
  edit(owner, ref, 'newer typing while counts wait')
  assert.equal(owner.getCurrentDiskConflict(conflict).mine, 'newer typing while counts wait')
  await owner.flush()
  assert.equal(owner.getCurrentDiskConflict(conflict), null)
})


test('saved publication skips initial reads and edits, then reports current prose on delayed acknowledgement', { timeout: 5000 }, async () => {
  const saved = []
  const { owner, transport } = await fixture({ onSaved: (context, snapshot) => saved.push({ context, snapshot }) })
  assert.equal(saved.length, 0)
  edit(owner, ref, '<p>Saved first.</p>')
  assert.equal(saved.length, 0)
  let release
  transport.commit = async request => {
    const result = { status: 'committed', hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) }
    if (release) return result
    return new Promise(resolve => { release = () => resolve(result) })
  }
  const saving = owner.flush()
  edit(owner, ref, '<p>Newer unsaved words remain.</p>')
  release()
  await saving
  assert.equal(saved.length, 2)
  assert.equal(saved[0].snapshot.html, '<p>Newer unsaved words remain.</p>')
  assert.deepEqual(structuredClone(saved[0].context), context)
  transport.commit = async request => ({ status: 'committed', hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
  edit(owner, ref, '<p><br></p>')
  await owner.flush()
  assert.equal(saved.at(-1).snapshot.html, '<p><br></p>')
})


test('clean external refresh, explicit resolution and recovered disk publish scoped saved prose', async () => {
  const saved = []
  const { owner, disk } = await fixture({ onSaved: (context, snapshot) => saved.push({ context, snapshot }) })
  disk.set(documents.sceneRefKey(ref), { html: '<p>External words.</p>', hash: 'external' })
  await owner.refreshFromDisk(ref)
  assert.equal(saved.at(-1)?.snapshot.html, '<p>External words.</p>')
  edit(owner, ref, '<p>Local words.</p>')
  disk.set(documents.sceneRefKey(ref), { html: '<p>Conflict words.</p>', hash: 'conflict' })
  const { conflict } = await owner.refreshFromDisk(ref)
  await owner.resolveDiskConflict(conflict, conflict.theirs, async request => ({ status: 'committed', hashes: [{ ref: request.ref, hash: 'resolved' }] }))
  assert.equal(saved.at(-1)?.snapshot.html, '<p>Conflict words.</p>')
  const recovery = await owner.prepareRecovery()
  const next = { ...context, workspaceEpoch: context.workspaceEpoch + 1 }
  recovery.apply(next)
  recovery.refresh(owner.getSnapshot(ref), { html: '<p>Recovered words.</p>', hash: 'recovered' })
  recovery.release()
  assert.equal(saved.at(-1)?.snapshot.html, '<p>Recovered words.</p>')
  assert.equal(saved.at(-1)?.context.workspaceEpoch, next.workspaceEpoch)
  assert.equal(saved.length, 3)
})
