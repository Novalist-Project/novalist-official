import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { loadRendererSource } from './renderer-source-loader.mjs'

const require = createRequire(import.meta.url)
const result = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/stores/writingPersistence'; export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/shared/ProseDocumentHost'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { getWritingDocumentRegistry, transferRecoveredWritingRegistry, acceptWritingTransaction, getWritingHistory,
  rebindWritingHistory, disposeWritingHistories, closeWritingDocumentRegistry, reserveWritingBatch } = module.exports
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const Y = require('yjs')

function fixture() {
  const workspaceId = crypto.randomUUID()
  let epoch = 7, fail = false, disk = 'Before', hash = 'before'
  const requests = [], receipts = new Map()
  const options = { context: { workspaceId, workspaceEpoch: epoch, bookId: 'book', draftId: 'draft' },
    isCurrent: context => context.workspaceId === workspaceId && context.workspaceEpoch === epoch,
    transport: { read: async () => ({ html: disk, hash }), activate: async () => true,
      commit: async request => {
        requests.push(structuredClone(request))
        const receipt = receipts.get(request.transactionId)
        if (receipt) return receipt
        assert.equal(request.expectedEpoch, epoch)
        disk = request.changes.at(-1)?.afterHtml ?? disk
        hash = 'committed'
        const committed = { status: 'committed', operationId: request.transactionId,
          hashes: request.changes.map(change => ({ ref: change.ref, hash })) }
        receipts.set(request.transactionId, committed)
        if (fail) throw new Error('Lost acknowledgement')
        return committed
      } } }
  const owner = getWritingDocumentRegistry(options)
  const edit = afterHtml => acceptWritingTransaction(owner, { id: crypto.randomUUID(), context: owner.context,
    origin: 'writer', kind: 'input', changes: [{ ref, expectedRevision: owner.getSnapshot(ref).revision,
      beforeHtml: owner.getSnapshot(ref).html, afterHtml }], annotationChanges: [], beforeSelection: null, afterSelection: null })
  return { owner, options, requests, edit, fail: () => { fail = true }, epoch: value => { epoch = value },
    external: value => { disk = value; hash = 'external' },
    close: async () => { await closeWritingDocumentRegistry(owner.context); disposeWritingHistories(workspaceId) } }
}

function workspaceRecovery(f) {
  return loadRendererSource('src/stores/writingWorkspaceRecovery.ts', {
    './writingDocuments': { ...module.exports, createWritingRpcTransport: () => f.options.transport },
    './writingHistory': module.exports,
    '../collaboration/sharedWritingSessions': {}, '../collaboration/sharedDocuments': {},
    '../collaboration/sharedWritingAnnotations': { rebaseSharedWritingAnnotations: async () => {} }
  })
}

test('backend epoch reset retains dirty canonical prose, saved hash and undo on the same owner', async () => {
  const f = fixture()
  await f.owner.read(ref)
  f.edit('After')
  const history = getWritingHistory(f.owner)
  const recovery = await f.owner.prepareRecovery()
  assert.throws(() => f.edit('Unexpected edit'), /recovering/)
  await assert.rejects(f.owner.read(ref), /recovering/)
  await assert.rejects(f.owner.reserveExternal('unexpected'), /recovering/)
  f.epoch(0)
  const next = { ...f.owner.context, workspaceEpoch: 0 }
  transferRecoveredWritingRegistry(f.owner, recovery, next)
  rebindWritingHistory(f.owner, f.owner)
  recovery.release()
  assert.equal(getWritingDocumentRegistry({ ...f.options, context: next }), f.owner)
  assert.equal(f.owner.getSnapshot(ref).html, 'After')
  assert.equal(f.owner.captureExternal()[0].saved.hash, 'before')
  assert.equal(f.owner.isDirty, true)
  assert.equal((await history.undo()).status, 'applied')
  assert.equal(f.owner.getSnapshot(ref).html, 'Before')
  assert.equal((await history.redo()).status, 'applied')
  await f.owner.flush()
  assert.equal(f.requests[0].expectedEpoch, 0)
  await f.close()
})

test('lost commit acknowledgement retries the same transaction after recovery', async () => {
  const f = fixture()
  await f.owner.read(ref)
  f.edit('Committed before restart')
  f.fail()
  await assert.rejects(f.owner.flush(), /Lost acknowledgement/)
  const recovery = await f.owner.prepareRecovery()
  f.epoch(0)
  transferRecoveredWritingRegistry(f.owner, recovery, { ...f.owner.context, workspaceEpoch: 0 })
  rebindWritingHistory(f.owner, f.owner)
  recovery.release()
  assert.equal(f.owner.isDirty, true)
  await f.owner.flush()
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[0].transactionId, f.requests[1].transactionId)
  assert.deepEqual(f.requests[0].changes, f.requests[1].changes)
  assert.equal(f.requests[1].expectedEpoch, 0)
  assert.equal(f.owner.isDirty, false)
  await f.close()
})

test('clean owners survive equal epochs and a foreign recovery target is refused', async () => {
  const f = fixture()
  const original = await f.owner.read(ref)
  const recovery = await f.owner.prepareRecovery()
  assert.throws(() => transferRecoveredWritingRegistry(f.owner, recovery, { ...f.owner.context, bookId: 'other' }), /context/i)
  transferRecoveredWritingRegistry(f.owner, recovery, f.owner.context)
  recovery.release()
  assert.equal(await f.owner.read(ref), original)
  assert.equal(f.requests.length, 0)
  await f.close()
})

test('workspace recovery retains an unloaded book owner and refreshes clean disk changes before remount', async () => {
  const f = fixture()
  const otherRef = { ...ref, bookId: 'other-book' }
  const other = getWritingDocumentRegistry({ ...f.options, context: { ...f.options.context, bookId: 'other-book' } })
  await f.owner.read(ref)
  await other.read(otherRef)
  const recovery = await workspaceRecovery(f).prepareWritingWorkspaceRecovery(f.options.context.workspaceId)
  f.external('Changed on disk')
  f.epoch(0)
  await recovery.resume({ workspaceId: f.options.context.workspaceId, workspaceEpoch: 0 })
  recovery.release()
  assert.equal(f.owner.getSnapshot(ref).html, 'Changed on disk')
  assert.equal(other.getSnapshot(otherRef).html, 'Changed on disk')
  assert.equal(other.context.workspaceEpoch, 0)
  assert.equal(getWritingDocumentRegistry({ ...f.options, context: other.context }), other)
  await closeWritingDocumentRegistry(other.context)
  await f.close()
})

test('compound recovery retries one stable multi-book commit after an ambiguous acknowledgement', async () => {
  const f = fixture()
  const otherRef = { ...ref, bookId: 'other-book' }
  const other = getWritingDocumentRegistry({ ...f.options, context: { ...f.options.context, bookId: 'other-book' } })
  await f.owner.read(ref)
  await other.read(otherRef)
  reserveWritingBatch([f.owner, other], f.options.transport.commit)
  f.edit('First book')
  acceptWritingTransaction(other, { id: crypto.randomUUID(), context: other.context, origin: 'writer', kind: 'input',
    changes: [{ ref: otherRef, expectedRevision: 0, beforeHtml: 'Before', afterHtml: 'Second book' }], annotationChanges: [], beforeSelection: null, afterSelection: null })
  f.fail()
  await assert.rejects(f.owner.flush(), /Lost acknowledgement/)
  const recovery = await workspaceRecovery(f).prepareWritingWorkspaceRecovery(f.options.context.workspaceId)
  f.epoch(0)
  await recovery.resume({ workspaceId: f.options.context.workspaceId, workspaceEpoch: 0 })
  recovery.release()
  assert.equal(other.getSnapshot(otherRef).html, 'Second book')
  await other.flush()
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].transactionId, f.requests[0].transactionId)
  assert.equal(f.requests[1].expectedEpoch, 0)
  assert.deepEqual(f.requests[1].changes, f.requests[0].changes)
  assert.equal(f.owner.isDirty, false)
  assert.equal(other.isDirty, false)
  await closeWritingDocumentRegistry(other.context)
  await f.close()
})

function sharedRecoveryFixture(t, { lostAck = false, heldWrite = false, acknowledged = false } = {}) {
  const dom = new JSDOM('')
  const environment = { document: dom.window.document, toDisplayImages() {}, sanitizeSceneFragment(html) {
    const template = dom.window.document.createElement('template'); template.innerHTML = html; return template.content
  } }
  const host = new module.exports.ProseDocumentHost(environment.document, environment)
  const initial = host.seed('scene', '<p>Base</p>')
  const oldServer = new Y.Doc(), server = new Y.Doc()
  Y.applyUpdate(oldServer, initial); Y.applyUpdate(server, initial)
  let settleOld, oldCalls = 0, newCalls = 0, failNew = false
  const held = new Promise(resolve => { settleOld = resolve })
  const connections = {
    old: { subscribe: () => () => {}, read: async () => Y.encodeStateAsUpdate(oldServer), write: async update => {
      oldCalls++
      if (heldWrite) await held
      if (lostAck || acknowledged) Y.applyUpdate(oldServer, update)
      if (acknowledged) return
      throw new Error('The backend connection was lost')
    } },
    recovered: { subscribe: () => () => {}, read: async () => Y.encodeStateAsUpdate(server), write: async update => {
      newCalls++
      if (failNew) throw new Error('The recovered backend is unavailable')
      Y.applyUpdate(server, update)
    } }
  }
  const decodeState = state => Uint8Array.from(Buffer.from(state, 'base64'))
  const shared = { sessionId: 'old', itemId: 'scene-item', state: Buffer.from(initial).toString('base64') }
  const sessions = loadRendererSource('src/collaboration/sharedWritingSessions.ts', {
    dompurify: { default: () => ({}) }, '../../../shared/sceneSanitizer': { createSceneSanitizer: () => environment },
    './SharedSceneSession': module.exports, './SharedEditorSession': {}, './richEditingSurface': {},
    './sharedDocuments': { decodeState, sharedDocumentConnection: identity => connections[identity.sessionId] }
  }, { window: dom.window })
  const owner = sessions.getSharedWritingSession(shared)
  let epoch = 7, identity = shared
  const context = { workspaceId: crypto.randomUUID(), workspaceEpoch: epoch, bookId: 'book', draftId: 'draft' }
  const transport = { read: async () => ({ html: '<p>Base</p>', hash: 'shared', shared: identity }),
    activate: async () => true, commit: async () => assert.fail('Shared prose must use its CRDT channel') }
  const registry = getWritingDocumentRegistry({ context, transport, isCurrent: value => value.workspaceEpoch === epoch })
  const recoveryModule = loadRendererSource('src/stores/writingWorkspaceRecovery.ts', {
    './writingDocuments': { ...module.exports, createWritingRpcTransport: () => transport }, './writingHistory': module.exports,
    '../collaboration/sharedWritingSessions': sessions, '../collaboration/sharedDocuments': { decodeState },
    '../collaboration/sharedWritingAnnotations': { rebaseSharedWritingAnnotations: async () => {} }
  })
  const panePersistence = loadRendererSource('src/stores/writingPanePersistence.ts', {
    './writingDocuments': module.exports, '../collaboration/sharedWritingSessions': sessions,
    '../collaboration/sharedWritingAnnotations': { getSharedWritingAnnotations: () => ({ flush: async () => {} }) }
  })
  const nextIdentity = () => ({ ...shared, sessionId: 'recovered', state: Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64') })
  t.after(async () => {
    settleOld(); failNew = false
    if (!owner.isClosed) { await owner.rebindRecoveredConnection(connections.recovered, Y.encodeStateAsUpdate(server)); await owner.close() }
    await closeWritingDocumentRegistry(registry.context); disposeWritingHistories(context.workspaceId)
    host.dispose(); oldServer.destroy(); server.destroy(); dom.window.close()
  })
  return { owner, registry, sessions, connections, server, oldServer, shared, context, nextIdentity, settleOld,
    flushPane: () => panePersistence.flushWritingPane(registry, () => assert.fail('Shared prose cannot create a disk HTML conflict')),
    oldCalls: () => oldCalls, newCalls: () => newCalls, failNew: () => { failNew = true }, retryNew: () => { failNew = false },
    async recover() {
      const recovery = await recoveryModule.prepareWritingWorkspaceRecovery(context.workspaceId)
      epoch = 0; identity = nextIdentity()
      try { await recovery.resume({ workspaceId: context.workspaceId, workspaceEpoch: epoch }) }
      finally { recovery.release() }
    } }
}

for (const lostAck of [false, true]) test(`shared recovery retains queued CRDT edits, peer insert and local undo (lost acknowledgement=${lostAck})`, async t => {
  const f = sharedRecoveryFixture(t, { lostAck })
  await f.registry.read(ref)
  const doc = f.owner.doc, history = f.owner.history
  f.owner.transact(prose => prose.insert(4, ' local'))
  await assert.rejects(f.owner.flush(), /waiting to be saved/)
  if (lostAck) Y.applyUpdate(f.server, Y.encodeStateAsUpdate(f.oldServer))
  f.server.getText('prose').insert(0, 'peer ')
  await f.recover()
  await f.owner.flush()
  assert.equal(f.owner.doc, doc); assert.equal(f.owner.history, history)
  assert.equal(f.sessions.findSharedWritingSession(f.shared), undefined)
  assert.equal(f.sessions.findSharedWritingSession(f.nextIdentity()), f.owner)
  assert.equal(f.registry.getSnapshot(ref).shared.sessionId, 'recovered')
  assert.equal(f.owner.prose.toString(), 'peer Base local\n')
  assert.equal(f.server.getText('prose').toString(), 'peer Base local\n')
  f.owner.undo(); await f.owner.flush()
  assert.equal(f.server.getText('prose').toString(), 'peer Base\n')
  f.owner.redo(); await f.owner.flush()
  assert.equal(f.server.getText('prose').toString(), 'peer Base local\n')
  assert.equal(f.owner.dirty, false)
})

for (const acknowledged of [false, true]) test(`shared recovery waits for old in-flight publication and replays its queued successors (old acknowledgement=${acknowledged})`, async t => {
  const f = sharedRecoveryFixture(t, { lostAck: true, heldWrite: true, acknowledged })
  await f.registry.read(ref)
  f.owner.transact(prose => prose.insert(4, ' local'))
  await Promise.resolve()
  f.owner.transact(prose => prose.insert(10, ' second'))
  let finished = false
  const recovery = f.owner.rebindRecoveredConnection(f.connections.recovered, Y.encodeStateAsUpdate(f.server)).then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false); assert.equal(f.newCalls(), 0)
  assert.throws(() => f.owner.transact(prose => prose.insert(0, 'unsafe')), /recover/i)
  f.settleOld(); await recovery; await f.owner.flush()
  assert.equal(f.oldCalls(), 1)
  assert.equal(f.server.getText('prose').toString(), 'Base local second\n')
})

test('recovered shared publication can fail again without blocking recovery or losing its retry queue', async t => {
  const f = sharedRecoveryFixture(t)
  await f.registry.read(ref)
  f.owner.transact(prose => prose.insert(4, ' local'))
  await assert.rejects(f.owner.flush())
  f.failNew()
  await f.recover()
  assert.equal(f.registry.isDirty, false, 'shared publication is owned independently of the registry HTML')
  await assert.rejects(f.flushPane(), /waiting to be saved/)
  assert.equal(f.owner.dirty, true)
  assert.equal(f.owner.prose.toString(), 'Base local\n')
  assert.equal(f.registry.context.workspaceEpoch, 0)
  assert.equal(f.sessions.findSharedWritingSession(f.nextIdentity()), f.owner)
  f.retryNew(); await f.flushPane()
  assert.equal(f.owner.dirty, false)
  assert.equal(f.server.getText('prose').toString(), 'Base local\n')
})

test('shared recovery refuses foreign full identities and external reservations without changing its owner', async t => {
  const f = sharedRecoveryFixture(t)
  const source = { context: f.context, ref, shared: f.shared }
  const next = { context: { ...f.context, workspaceEpoch: 0 }, ref, shared: f.nextIdentity() }
  for (const wrong of [
    { ...next, context: { ...next.context, workspaceId: 'other' } },
    { ...next, context: { ...next.context, bookId: 'other' } },
    { ...next, context: { ...next.context, draftId: 'other' } },
    { ...next, context: { ...next.context, workspaceEpoch: -1 } },
    { ...next, ref: { ...ref, bookId: 'other' } },
    { ...next, ref: { ...ref, draftId: 'other' } },
    { ...next, ref: { ...ref, chapterGuid: 'other' } },
    { ...next, ref: { ...ref, sceneId: 'other' } },
    { ...next, shared: { ...next.shared, itemId: 'other' } }
  ]) await assert.rejects(f.sessions.transferRecoveredSharedWritingSession(source, wrong), /identity|context/i)
  const release = f.owner.reserveExternal('search')
  await assert.rejects(f.sessions.transferRecoveredSharedWritingSession(source, next), /reserv/i)
  release()
  f.owner.transact(prose => prose.insert(4, ' local'))
  await assert.rejects(f.owner.flush())
  assert.throws(() => f.sessions.transferSharedWritingSession(f.shared, next.shared), /Flush/)
  assert.equal(f.sessions.findSharedWritingSession(f.shared), f.owner)
  assert.equal(f.sessions.findSharedWritingSession(next.shared), undefined)
})

test('invalid recovered shared state keeps the old mapping, pending edits and undo available for a corrected retry', async t => {
  const f = sharedRecoveryFixture(t)
  f.owner.transact(prose => prose.insert(4, ' local'))
  await assert.rejects(f.owner.flush())
  const foreign = new Y.Doc()
  foreign.getText('unsupported').insert(0, 'invalid')
  const source = { context: f.context, ref, shared: f.shared }
  const next = { context: { ...f.context, workspaceEpoch: 0 }, ref, shared: f.nextIdentity() }
  await assert.rejects(f.sessions.transferRecoveredSharedWritingSession(source,
    { ...next, shared: { ...next.shared, state: Buffer.from(Y.encodeStateAsUpdate(foreign)).toString('base64') } }), /valid scene/)
  foreign.destroy()
  assert.equal(f.sessions.findSharedWritingSession(f.shared), f.owner)
  assert.equal(f.sessions.findSharedWritingSession(next.shared), undefined)
  assert.equal(f.owner.dirty, true)
  assert.equal(f.owner.prose.toString(), 'Base local\n')
  await f.sessions.transferRecoveredSharedWritingSession(source, next)
  await f.owner.flush(); f.owner.undo(); await f.owner.flush()
  assert.equal(f.server.getText('prose').toString(), 'Base\n')
})

test('shared recovery reserves both map identities while awaiting the old write', async t => {
  const f = sharedRecoveryFixture(t, { heldWrite: true })
  f.owner.transact(prose => prose.insert(4, ' local'))
  await Promise.resolve()
  const source = { context: f.context, ref, shared: f.shared }
  const next = { context: { ...f.context, workspaceEpoch: 0 }, ref, shared: f.nextIdentity() }
  const recovery = f.sessions.transferRecoveredSharedWritingSession(source, next)
  assert.throws(() => f.sessions.getSharedWritingSession(next.shared), /recover/)
  await assert.rejects(f.sessions.transferRecoveredSharedWritingSession(source, next), /already/)
  f.settleOld(); await recovery; await f.owner.flush()
  assert.equal(f.sessions.getSharedWritingSession(next.shared), f.owner)
  assert.equal(f.server.getText('prose').toString(), 'Base local\n')
})
