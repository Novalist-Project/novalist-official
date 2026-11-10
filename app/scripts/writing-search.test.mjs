import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { loadRendererSource } from './renderer-source-loader.mjs'
import * as search from '../src/renderer/src/views/editor/writingSearch.ts'
import { JSDOM } from 'jsdom'
import { writingTextMapping } from '../src/renderer/src/views/editor/writingTextMapping.ts'
import * as pendingWrites from '../src/renderer/src/stores/pendingWrites.ts'
import './writing-search-mixed.mjs'

const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'dirty-visible' }
const snapshot = { ...ref, html: '<p>dirty wolf</p>', hash: 'disk', revision: 2, dirty: true }
const context = { workspaceId: 'project', workspaceEpoch: 4 }
const plain = value => JSON.parse(JSON.stringify(value))

test('immutable captures overlay dirty visible prose and omit hidden filtered scenes', () => {
  const other = { ...ref, sceneId: 'clean-offscreen' }
  const hidden = { ...ref, sceneId: 'hidden' }
  const captures = [{ owner: 1, snapshots: [snapshot, { ...snapshot, ...hidden }] },
    { owner: 2, snapshots: [{ ...snapshot, html: '<p>old</p>', dirty: false }, { ...snapshot, ...other, dirty: false }] }]
  const result = search.captureSearchOverrides([ref, other], captures)
  assert.deepEqual(result.map(item => item.ref.sceneId), ['dirty-visible', 'clean-offscreen'])
  assert.equal(result[0].html, snapshot.html)
  const hiddenFilteredSceneChanged = result.some(item => item.ref.sceneId === hidden.sceneId)
  assert.equal(hiddenFilteredSceneChanged, false)
  captures[0].snapshots[0] = { ...snapshot, html: 'later edit' }
  assert.equal(result[0].html, snapshot.html)
  assert.throws(() => search.captureSearchOverrides([ref], [captures[0], { owner: 3, snapshots: [snapshot] }]), /conflicting/)
})

test('match navigation uses canonical UTF16 ranges through inline markup and paragraph breaks', () => {
  const document = new JSDOM('<main><p>\uD834\uDD1E <b>wolf</b><br>next</p><p>end</p></main>').window.document
  const root = document.querySelector('main')
  const expectedMatch = 'wolf\nnext'
  const selection = search.matchSelection({ ref, index: 3, length: expectedMatch.length })
  const start = writingTextMapping.domPoint(root, selection.anchor.offset, selection.anchor.affinity)
  const end = writingTextMapping.domPoint(root, selection.focus.offset, selection.focus.affinity)
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  const extracted = document.createElement('div')
  extracted.append(range.cloneContents())
  const highlightedText = writingTextMapping.parts(extracted).map(part => part.text).join('').replace(/\n$/, '')
  assert.equal(highlightedText, expectedMatch)
  assert.equal(writingTextMapping.parts(root).map(part => part.text).join(''), '\uD834\uDD1E wolf\nnext\nend\n')
})

test('replacement validates full references, content, revision and saved hash', () => {
  const change = { ref, expectedRevision: 2, expectedHash: 'disk', beforeHtml: snapshot.html, afterHtml: '<p>fox</p>' }
  search.validateSearchChanges([change], [snapshot])
  for (const altered of [{ ...snapshot, revision: 3 }, { ...snapshot, hash: 'new' }, { ...snapshot, html: 'remote' }, { ...snapshot, draftId: 'other' }]) {
    assert.throws(() => search.validateSearchChanges([change], [altered]), /changed/)
  }
})

test('renderer search resolves every scope with passive targets and the captured dirty override', async () => {
  const other = { ...ref, sceneId: 'offscreen' }
  const remote = { ...ref, bookId: 'other', chapterGuid: 'elsewhere', sceneId: 'remote' }
  const targets = [ref, other, remote].map(ref => ({ ref, sceneTitle: ref.sceneId, chapterTitle: ref.chapterGuid, bookTitle: ref.bookId }))
  const requests = []
  const state = { projectPath: context.workspaceId, workspaceEpoch: 4, activeBookId: 'book', activeDraftId: 'draft', openChapterGuid: ref.chapterGuid, openSceneId: ref.sceneId }
  const host = loadRendererSource('src/views/editor/writingSearchHost.ts', {
    '../../rpc/client': { rpc: { request: async (method, args) => {
      requests.push([method, args])
      if (method === 'writingSearch/targets') return targets.filter(target => args[2] || target.ref.bookId === args[0])
      assert.equal(method, 'writingSearch/find')
      return []
    } } },
    '../../stores/projectStore': { useProjectStore: { getState: () => state } },
    '../../stores/shellStore': { useShellStore: { getState: () => ({ activePaneId: 'pane' }) } },
    './writingNavigation': { getWritingNavigation: () => ({ references: new Map([[ref.sceneId, ref]]) }) },
    '../../stores/pendingWrites': pendingWrites,
    '../../stores/writingHistory': {}, '../../collaboration/SharedWritingHistory': {}, '../../collaboration/sharedWritingSessions': {},
    './writingSearchCapture': { captureWritingSearch: async () => [{ owner: 1, snapshots: [snapshot] }] },
    './writingSearchExternal': {}, './writingSearch': search, './writingTextMapping': { writingTextMapping }
  })
  for (const [scope, expected] of [['Projection', [ref]], ['CurrentScene', [ref]], ['CurrentChapter', [ref, other]], ['ActiveBook', [ref, other]], ['Project', [ref, other, remote]]]) {
    const result = await host.findWriting({ pattern: 'wolf', includeSceneNotes: true, includeCodex: true }, scope)
    assert.deepEqual(plain(result.request.targets), expected)
    assert.equal(result.request.overrides[0].html, snapshot.html)
    assert.equal(result.request.options.includeSceneNotes, true)
  }
  assert.equal(requests.some(([method]) => method === 'writing/commit' || method === 'project/switchBook'), false)
})

test('one-window mixed replacement uses the durable coordinator before either channel mutates', async () => {
  const sharedRef = { ...ref, sceneId: 'shared' }
  const shared = { ...snapshot, ...sharedRef, shared: { sessionId: 'session', itemId: 'item', state: '' } }
  const snapshots = [snapshot, shared]
  const changes = snapshots.map(before => ({ ref: before, beforeHtml: before.html, afterHtml: '<p>fox</p>', expectedHash: before.hash, expectedRevision: before.revision }))
  const registry = { read: async target => snapshots.find(item => item.sceneId === target.sceneId), getSnapshot: target => snapshots.find(item => item.sceneId === target.sceneId), context: { ...context, bookId: 'book', draftId: 'draft' } }
  let coordinated = 0
  const host = loadRendererSource('src/views/editor/writingSearchHost.ts', {
    '../../rpc/client': { rpc: { request: async () => changes } },
    '../../stores/projectStore': { useProjectStore: { getState: () => ({ projectPath: 'project', workspaceEpoch: 4, activeBookId: 'book', activeDraftId: 'draft', getWritingRegistry: () => registry }) } },
    '../../stores/shellStore': {}, './writingNavigation': {}, '../../stores/pendingWrites': { capturePendingWrites() {} },
    '../../stores/writingHistory': { acceptWritingBatch() { assert.fail('local published early') }, acceptSharedWritingBatch() { assert.fail('shared published early') } },
    '../../collaboration/SharedWritingHistory': {},
    '../../collaboration/sharedWritingSessions': { getSharedWritingSession: () => ({ html: shared.html, revision: shared.revision }) },
    './writingSearchCapture': { captureWritingSearch: async () => [{ owner: 1, snapshots }] },
    './writingSearchExternal': { replaceWritingAcrossWindows: async () => { coordinated++; return 2 } },
    './writingSearch': search, './writingTextMapping': { writingTextMapping }
  }, { crypto: { randomUUID } })
  const result = { request: { targets: [ref, sharedRef], overrides: [], expectedEpoch: 4 }, matches: [], targets: [] }
  assert.equal(await host.replaceWriting(result, [{ ref }, { ref: sharedRef }], 'fox'), 2)
  assert.equal(coordinated, 1)
})

test('search navigation opened outside an editor waits for mount and restores the exact match', async () => {
  let mounted = false
  let revealed
  let html = snapshot.html
  const registry = { read: async () => ({ ...snapshot, html }), getSnapshot: () => ({ ...snapshot, html }) }
  const state = { projectPath: context.workspaceId, workspaceEpoch: 4, activeBookId: ref.bookId, activeDraftId: ref.draftId,
    getWritingRegistry: () => registry, openScene: async () => { mounted = true } }
  const host = loadRendererSource('src/views/editor/writingSearchHost.ts', {
    '../../rpc/client': {}, '../../stores/projectStore': { useProjectStore: { getState: () => state } },
    '../../stores/shellStore': { useShellStore: { getState: () => ({ activePaneId: 'pane' }) } },
    './writingNavigation': { getWritingNavigation: () => mounted ? { capture() {}, reveal: (target, selection) => { revealed = { target, selection }; return true } } : null },
    '../../stores/pendingWrites': {}, '../../stores/writingHistory': {}, '../../collaboration/SharedWritingHistory': {},
    '../../collaboration/sharedWritingSessions': {}, './writingSearchCapture': {}, './writingSearchExternal': {},
    './writingSearch': search, './writingTextMapping': { writingTextMapping }
  }, { DOMParser: new JSDOM().window.DOMParser })
  const match = { ref, index: 6, length: 4, matchedText: 'wolf' }
  await host.revealWritingMatch(match)
  assert.deepEqual(plain(revealed), { target: ref, selection: plain(search.matchSelection(match)) })
  mounted = false
  revealed = undefined
  html = '<p>dirty bird</p>'
  await assert.rejects(host.revealWritingMatch(match), /changed/)
  assert.equal(revealed, undefined, 'stale editor-entry result must never select unrelated text')
})

test('release during a pending save cancels preparation and cannot strand its late reservation', async () => {
  const documents = loadRendererSource('src/stores/writingDocuments.ts', { './pendingWrites': pendingWrites }, { crypto, structuredClone })
  let finishSave
  const saving = new Promise(resolve => { finishSave = resolve })
  const ownerContext = { ...context, bookId: ref.bookId, draftId: ref.draftId }
  const registry = documents.getWritingDocumentRegistry({ context: ownerContext, isCurrent: () => true,
    transport: { read: async () => ({ html: '<p>saved</p>', hash: 'old' }), activate: async () => true,
      commit: async () => saving } })
  await registry.read(ref)
  registry.apply({ id: 'typed', context: ownerContext, origin: 'writer', kind: 'input', changes: [{ ref,
    beforeHtml: '<p>saved</p>', afterHtml: snapshot.html, expectedRevision: 0 }], annotationChanges: [] })
  const flushing = registry.flush()
  let receive
  const replies = []
  const dom = new JSDOM('<iframe></iframe>')
  const receiver = loadRendererSource('src/views/editor/writingSearchLease.ts', {
    '../../stores/writingDocuments': documents, '../../stores/pendingWrites': pendingWrites,
    '../../stores/writingHistory': {}, '../../stores/projectStore': {}, '../../rpc/client': {},
    './writingSearchExternal': {}, '../../collaboration/sharedWritingSessions': {},
    '../../collaboration/sharedWritingUpdates': {}, './writingSearch': search
  }, { document: dom.window.document, window: { novalist: { onWritingSearchLease: handler => { receive = handler }, writingSearchLeaseAck: reply => replies.push(reply) } } })
  receiver.installWritingSearchLease()
  const request = { ...context, token: 'cancel-pending', refs: [ref] }
  receive({ ...request, stage: 'prepare' })
  await new Promise(resolve => setImmediate(resolve))
  receive({ ...request, stage: 'release' })
  finishSave({ status: 'committed', operationId: 'save', hashes: [{ ref, hash: 'saved' }] })
  await flushing
  await new Promise(resolve => setImmediate(resolve))
  assert.doesNotThrow(() => registry.validate({ id: 'next', context: ownerContext, changes: [], annotationChanges: [] }))
  assert.equal(dom.window.document.querySelector('iframe').inert, undefined)
  assert.equal(replies.find(reply => reply.stage === 'prepare')?.error !== undefined, true)
  registry.captureExternal = () => { throw new Error('snapshot capture failed') }
  receive({ ...request, token: 'failed-capture', stage: 'prepare' })
  await new Promise(resolve => setImmediate(resolve))
  assert.doesNotThrow(() => registry.validate({ id: 'after-failed-capture', context: ownerContext, changes: [], annotationChanges: [] }))
  assert.equal(dom.window.document.querySelector('iframe').inert, undefined)
  assert.equal(replies.find(reply => reply.token === 'failed-capture')?.error !== undefined, true)
  await registry.close()
  dom.window.close()
})

test('desktop capture waits for every authenticated owner and rejects window loss', async () => {
  const { WritingSearchCaptureBroker } = loadRendererSource('../main/writing-search.ts', { 'node:crypto': { randomUUID } })
  const broker = new WritingSearchCaptureBroker()
  const requests = []
  broker.register(1, request => requests.push(request))
  broker.register(2, request => requests.push(request))
  const capturing = broker.capture(context)
  const token = requests[0].token
  broker.acknowledge(9, { token, snapshots: [] })
  broker.acknowledge(1, { token, snapshots: [snapshot] })
  broker.acknowledge(2, { token, snapshots: [] })
  assert.deepEqual(plain(await capturing).map(item => item.owner), [1, 2])
  const losingWindow = broker.capture(context)
  broker.remove(2)
  await assert.rejects(losingWindow, /closed/)
})

test('exclusive crosswindow lease authenticates requester and retains failed commit acknowledgements', async () => {
  const { WritingSearchLeaseBroker } = loadRendererSource('../main/writing-search-lease.ts', { 'node:crypto': { randomUUID } })
  const broker = new WritingSearchLeaseBroker()
  let rejectCommit = false
  const stages = []
  for (const owner of [1, 2]) broker.register(owner, request => {
    stages.push(request.stage)
    queueMicrotask(() => broker.acknowledge(owner, { token: request.token, stage: request.stage,
      documents: [{ current: snapshot, saved: { ...snapshot, html: '<p>old</p>' } }],
      ...(rejectCommit && owner === 2 && request.stage === 'commit' ? { error: 'retry' } : {}) }))
  })
  const lease = await broker.acquire(1, context, [ref])
  assert.equal(lease.owners.length, 2)
  await assert.rejects(broker.acquire(2, context, [ref]), /pending/)
  await assert.rejects(broker.finish(2, lease.token), /unavailable/)
  rejectCommit = true
  await assert.rejects(broker.finish(1, lease.token, [{ ref, afterHtml: 'fox', hash: 'next' }]), /retry/)
  rejectCommit = false
  await broker.finish(1, lease.token, [{ ref, afterHtml: 'fox', hash: 'next' }])
  await broker.finish(1, lease.token)
  assert.deepEqual(stages, ['prepare', 'prepare', 'commit', 'commit', 'commit', 'commit', 'release', 'release'])
})

test('project replacement publishes one commit across real remote owners and undo restores dirty before content', async () => {
  const { WritingDocumentRegistry } = loadRendererSource('src/stores/writingDocuments.ts', { './pendingWrites': pendingWrites }, { crypto, structuredClone })
  const { WritingSearchLeaseBroker } = loadRendererSource('../main/writing-search-lease.ts', { 'node:crypto': { randomUUID } }, { structuredClone })
  let requestRpc
  const broker = new WritingSearchLeaseBroker(request => requestRpc('writing/commit', [request]))
  const firstContext = { ...context, bookId: 'book', draftId: 'draft' }
  const otherRef = { ...ref, bookId: 'other-book', sceneId: 'offscreen' }
  const disk = new Map([[search.searchRefKey(ref), { html: '<p>saved wolf</p>', hash: 'first' }],
    [search.searchRefKey(otherRef), { html: '<p>other wolf</p>', hash: 'second' }]])
  const registries = [firstContext, { ...firstContext, bookId: 'other-book' }].map(context => new WritingDocumentRegistry({ context,
    isCurrent: () => true, transport: { read: async ref => disk.get(search.searchRefKey(ref)), activate: async () => true,
      commit: async () => { throw new Error('No independent autosave during external publication') } } }))
  await registries[0].read(ref)
  await registries[1].read(otherRef)
  registries[0].apply({ id: 'typing', context: firstContext, origin: 'writer', kind: 'input', changes: [{ ref,
    expectedRevision: 0, beforeHtml: '<p>saved wolf</p>', afterHtml: '<p>dirty wolf</p>' }], annotationChanges: [] })
  for (const [index, registry] of registries.entries()) {
    let receive
    const document = new JSDOM('<iframe></iframe>').window.document
    const receiver = loadRendererSource('src/views/editor/writingSearchLease.ts', {
      '../../stores/writingDocuments': { getWritingRegistries: () => [registry] }, '../../stores/pendingWrites': pendingWrites,
      '../../collaboration/sharedWritingSessions': {}, '../../collaboration/sharedWritingUpdates': {},
      '../../stores/writingHistory': { rebindWritingHistory() {} }, '../../stores/projectStore': {}, './writingSearchExternal': { rebasePendingWritingReplacement() {} },
      '../../rpc/client': {},
      './writingSearch': search
    }, { document, window: { novalist: { onWritingSearchLease: handler => { receive = handler }, writingSearchLeaseAck: reply => broker.acknowledge(index + 1, reply) } } })
    receiver.installWritingSearchLease()
    broker.register(index + 1, request => receive(request))
  }
  let history
  let commits = 0
  requestRpc = async (method, args) => {
      if (method === 'writingSearch/prepareReplace') return args[0].overrides.map(snapshot => ({ ref: snapshot.ref, beforeHtml: snapshot.html,
        afterHtml: snapshot.html.replaceAll('wolf', args[2]), expectedHash: snapshot.hash, expectedRevision: snapshot.revision }))
      assert.equal(method, 'writing/commit')
      commits++
      const request = args[0]
      for (const change of request.changes) assert.equal(disk.get(search.searchRefKey(change.ref)).html, change.beforeHtml)
      const hashes = request.changes.map(change => {
        const hash = 'saved-' + commits + '-' + change.ref.bookId
        disk.set(search.searchRefKey(change.ref), { html: change.afterHtml, hash })
        return { ref: change.ref, hash }
      })
      return { status: 'committed', hashes, operationId: 'operation' }
    }
  const external = loadRendererSource('src/views/editor/writingSearchExternal.ts', {
    '../../rpc/client': { rpc: { request: requestRpc } },
    '../../stores/projectStore': { useProjectStore: { getState: () => ({ projectPath: context.workspaceId, workspaceEpoch: context.workspaceEpoch, getWritingRegistry: () => registries[0] }) } },
    '../../stores/writingHistory': { recordExternalWritingTransaction: (_owner, _transaction, callbacks) => { history = callbacks } },
    '../../collaboration/sharedWritingGroup': {}, '../../collaboration/sharedWritingSessions': {},
    './writingSearch': search
  }, { crypto, window: { novalist: { acquireWritingSearchLease: (context, refs) => broker.acquire(1, context, refs),
    finishWritingSearchLease: (token, changes) => broker.finish(1, token, changes),
    publishWritingSearchLease: (token, request, changes) => broker.publish(1, token, request, changes) } } })
  const refs = [ref, otherRef]
  const beforeReplaceAll = registries.map(registry => registry.capture()[0].html)
  const overrides = search.captureSearchOverrides(refs, registries.map((registry, owner) => ({ owner, snapshots: registry.capture() })))
  const matches = refs.map(ref => ({ ref, field: 'prose' }))
  await external.replaceWritingAcrossWindows(firstContext, { request: { targets: refs, overrides, expectedEpoch: 4, options: { pattern: 'wolf' } } }, matches, 'fox')
  assert.equal(commits, 1)
  assert.deepEqual(registries.map(registry => registry.capture()[0].html), ['<p>dirty fox</p>', '<p>other fox</p>'])
  assert.equal((await history.undo()).status, 'applied')
  const afterReplaceAllUndo = registries.map(registry => registry.capture()[0].html)
  assert.deepEqual(afterReplaceAllUndo, beforeReplaceAll)
  assert.equal(commits, 2)
  assert.equal((await history.redo()).status, 'applied')
  assert.equal(commits, 3)
})

test('main retains publication across requester loss and a lost reply never repeats the journal commit', async () => {
  const { WritingSearchLeaseBroker } = loadRendererSource('../main/writing-search-lease.ts', { 'node:crypto': { randomUUID } }, { structuredClone })
  let commits = 0
  let finishCommit
  const committed = new Promise(resolve => { finishCommit = resolve })
  const broker = new WritingSearchLeaseBroker(async () => { commits++; return committed })
  const stages = []
  for (const owner of [1, 2]) broker.register(owner, request => {
    stages.push([owner, request.stage])
    queueMicrotask(() => broker.acknowledge(owner, { token: request.token, stage: request.stage, documents: [] }))
  })
  const lease = await broker.acquire(1, context, [ref])
  const request = { transactionId: 'stable-retry-id', expectedEpoch: 4, changes: [{ ref, beforeHtml: 'old', afterHtml: 'new', expectedRevision: 0 }], annotationChanges: [] }
  const after = [{ ref, afterHtml: 'new' }]
  const publishing = broker.publish(1, lease.token, request, after)
  broker.remove(1)
  finishCommit({ status: 'committed', operationId: 'operation', hashes: [{ ref, hash: 'new-hash' }] })
  assert.equal((await publishing).status, 'committed')
  assert.equal((await broker.publish(1, lease.token, request, after)).status, 'committed')
  assert.equal(commits, 1)
  assert.deepEqual(stages, [[1, 'prepare'], [2, 'prepare'], [2, 'commit'], [2, 'release']])
  await assert.rejects(broker.publish(2, lease.token, request, after), /receipt/)
})

test('retryable publication keeps the lease and repeats the same transaction until durable acknowledgement', async () => {
  const { WritingSearchLeaseBroker } = loadRendererSource('../main/writing-search-lease.ts', { 'node:crypto': { randomUUID } }, { structuredClone })
  const ids = []
  const broker = new WritingSearchLeaseBroker(async request => {
    ids.push(request.transactionId)
    return ids.length === 1 ? { status: 'retryable', errorCode: 'disk-full' }
      : { status: 'committed', hashes: [{ ref, hash: 'new' }], operationId: 'operation' }
  })
  broker.register(1, request => queueMicrotask(() => broker.acknowledge(1, { token: request.token, stage: request.stage, documents: [] })))
  const lease = await broker.acquire(1, context, [ref])
  const request = { transactionId: 'stable', expectedEpoch: 4, changes: [{ ref, beforeHtml: 'old', afterHtml: 'new' }], annotationChanges: [] }
  const after = [{ ref, afterHtml: 'new' }]
  assert.equal((await broker.publish(1, lease.token, request, after)).status, 'retryable')
  await assert.rejects(broker.acquire(1, context, [ref]), /pending/)
  assert.equal((await broker.publish(1, lease.token, request, after)).status, 'committed')
  assert.deepEqual(ids, ['stable', 'stable'])
})

test('leased dirty owner transfers synchronously across lower and equal restart epochs before replacement owners mount', async () => {
  const documents = loadRendererSource('src/stores/writingDocuments.ts', { './pendingWrites': pendingWrites }, { crypto, structuredClone })
  const { WritingSearchLeaseBroker } = loadRendererSource('../main/writing-search-lease.ts', { 'node:crypto': { randomUUID } }, { structuredClone })
  let epoch = 4
  const initialContext = { ...context, bookId: ref.bookId, draftId: ref.draftId }
  const options = { context: initialContext, isCurrent: context => context.workspaceEpoch === epoch,
    transport: { read: async () => ({ html: 'saved', hash: 'original' }), activate: async () => true, commit: async () => { throw new Error('No competing save') } } }
  const registry = documents.getWritingDocumentRegistry(options)
  await registry.read(ref)
  let receive
  let retry = true
  const sentEpochs = []
  const broker = new WritingSearchLeaseBroker(async request => {
    sentEpochs.push(request.expectedEpoch)
    return retry ? { status: 'retryable', errorCode: 'restarting' }
      : { status: 'committed', hashes: [{ ref, hash: 'saved-' + request.transactionId }], operationId: 'operation' }
  })
  const receiver = loadRendererSource('src/views/editor/writingSearchLease.ts', {
    '../../stores/writingDocuments': documents, '../../stores/pendingWrites': pendingWrites,
    '../../stores/writingHistory': { rebindWritingHistory() {} },
    '../../stores/projectStore': { useProjectStore: { getState: () => ({ projectPath: context.workspaceId, workspaceEpoch: epoch }) } },
    '../../rpc/client': {},
    './writingSearchExternal': { rebasePendingWritingReplacement() {} },
    '../../collaboration/sharedWritingSessions': {}, '../../collaboration/sharedWritingUpdates': {}, './writingSearch': search
  }, { document: new JSDOM('<iframe></iframe>').window.document, window: { novalist: {
    onWritingSearchLease: handler => { receive = handler }, writingSearchLeaseAck: reply => broker.acknowledge(1, reply)
  } } })
  receiver.installWritingSearchLease()
  broker.register(1, request => receive(request))
  for (const iteration of [1, 2]) {
    const before = registry.getSnapshot(ref)
    registry.apply({ id: 'typed-' + iteration, context: registry.context, origin: 'writer', kind: 'input', changes: [{ ref,
      beforeHtml: before.html, afterHtml: 'dirty-' + iteration, expectedRevision: before.revision }], annotationChanges: [] })
    const lease = await broker.acquire(1, { ...context, workspaceEpoch: epoch }, [ref])
    const commit = { transactionId: 'replacement-' + iteration, expectedEpoch: epoch,
      changes: [{ ref, beforeHtml: before.html, afterHtml: 'replaced-' + iteration, expectedRevision: before.revision }], annotationChanges: [] }
    retry = true
    assert.equal((await broker.publish(1, lease.token, commit, [{ ref, afterHtml: 'replaced-' + iteration }])).status, 'retryable')
    assert.throws(() => receiver.validateWritingSearchRecovery({ workspaceId: 'other', workspaceEpoch: 0 }), /previous workspace/)
    epoch = 0
    receiver.rebaseWritingSearchLeases({ ...context, workspaceEpoch: epoch })
    const remounted = documents.getWritingDocumentRegistry({ ...options, context: { ...initialContext, workspaceEpoch: epoch } })
    assert.equal(remounted, registry, 'React must reuse the leased owner, not create a competing replacement registry')
    assert.equal(registry.getSnapshot(ref).html, 'dirty-' + iteration)
    retry = false
    await broker.recover({ ...context, workspaceEpoch: epoch })
    assert.equal(registry.getSnapshot(ref).html, 'replaced-' + iteration)
    assert.equal(registry.isDirty, false)
  }
  assert.deepEqual(sentEpochs, [4, 0, 0, 0])
  await registry.close()
})
