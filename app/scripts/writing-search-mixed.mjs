import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const built = await build({ stdin: { contents: `
  export * from './src/renderer/src/collaboration/SharedSceneSession';
  export * from './src/renderer/src/collaboration/sharedWritingGroup';
  export * from './src/shared/ProseDocumentHost';
  export * from './src/main/writing-search-publication';
  export * from './src/main/writing-search-lease';
  export * from './src/renderer/src/stores/writingDocuments';
`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
runInNewContext(built.outputFiles[0].text, { require, module, exports: module.exports,
  crypto, structuredClone, setTimeout, clearTimeout, queueMicrotask, console, Uint8Array, atob, btoa })
const { SharedSceneSession, prepareSharedWritingGroup, ProseDocumentHost, WritingSearchPublicationStore, WritingSearchLeaseBroker, WritingDocumentRegistry } = module.exports

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'novalist-search-saga-'))
  const dom = new JSDOM('<body></body>')
  const document = dom.window.document
  const environment = { document, sanitizeSceneFragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content }, toDisplayImages() {} }
  const host = new ProseDocumentHost(document, environment)
  const seed = host.seed('shared', '<p>shared wolf</p>')
  const server = new Y.Doc()
  Y.applyUpdate(server, seed)
  const identity = { sessionId: 'session', itemId: 'shared', state: Buffer.from(seed).toString('base64') }
  const session = new SharedSceneSession(environment, seed, { read: async () => Y.encodeStateAsUpdate(server), subscribe: () => () => {}, write: async update => Y.applyUpdate(server, update) })
  const localRef = { bookId: 'local-book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'local' }
  const sharedRef = { ...localRef, bookId: 'shared-book', sceneId: 'shared' }
  const context = { workspaceId: directory, workspaceEpoch: 2 }
  const group = await prepareSharedWritingGroup('shared-operation', [{ ref: sharedRef, identity, session,
    expectedRevision: session.revision, beforeHtml: session.html, afterHtml: '<p>shared fox</p>' }])
  let localHtml = '<p>local wolf</p>'
  let fail = false
  let conflict = false
  let commits = 0
  const calls = []
  const request = async (method, args) => {
    calls.push(method)
    if (method === 'scenes/readPassive') return { shared: identity }
    if (method === 'collaboration/writeScene') {
      const receipts = (await readdir(directory)).filter(name => name.endsWith('.json'))
      assert.equal(receipts.length, 1, 'durable intent precedes every collaborative write')
      assert.equal(JSON.parse(await readFile(join(directory, receipts[0]), 'utf8')).shared.groupId, group.intent.groupId)
      Y.applyUpdate(server, Uint8Array.from(Buffer.from(args[2], 'base64')))
      return null
    }
    assert.equal(method, 'writing/commit')
    commits++
    if (fail) return { status: 'retryable', operationId: 'journal', errorCode: 'disk-full' }
    if (conflict) return { status: 'conflict', conflicts: [{ ref: localRef, hash: 'changed' }] }
    localHtml = args[0].changes[0].afterHtml
    return { status: 'committed', operationId: 'journal', hashes: [{ ref: localRef, hash: 'new-local' }] }
  }
  const commit = { transactionId: 'local-operation', expectedEpoch: 2, changes: [{ ref: localRef, expectedRevision: 0,
    expectedHash: 'local', beforeHtml: localHtml, afterHtml: '<p>local fox</p>' }], annotationChanges: [] }
  t.after(async () => { group.dispose(); await session.close(); server.destroy(); host.dispose(); dom.window.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, session, server, group, localRef, sharedRef, context, request, commit, calls,
    localHtml: () => localHtml, commits: () => commits, fail: value => { fail = value }, conflict: value => { conflict = value } }
}

test('durable mixed receipt resumes after requester loss between shared publication and local commit', async t => {
  const f = await fixture(t)
  const store = new WritingSearchPublicationStore(f.directory, f.request)
  f.fail(true)
  assert.equal((await store.publish(f.commit, { token: 'lease', context: f.context, shared: f.group.intent })).status, 'retryable')
  assert.match(f.server.getText('prose').toString(), /shared fox/)
  assert.equal(f.localHtml(), '<p>local wolf</p>')
  f.server.getText('prose').insert(0, 'Peer ')
  f.fail(false)
  const recovered = new WritingSearchPublicationStore(f.directory, f.request)
  await Promise.all([recovered.recover({ ...f.context, workspaceEpoch: 3 }), recovered.recover({ ...f.context, workspaceEpoch: 3 })])
  assert.equal(f.localHtml(), '<p>local fox</p>')
  assert.match(f.server.getText('prose').toString(), /Peer shared fox/)
  assert.equal(f.commits(), 2)
})

test('local journal conflict compensates only the mixed operation and preserves peer text', async t => {
  const f = await fixture(t)
  f.conflict(true)
  let inserted = false
  const request = async (method, args) => {
    if (method === 'writing/commit' && !inserted) { inserted = true; f.server.getText('prose').insert(0, 'Peer ') }
    return f.request(method, args)
  }
  const store = new WritingSearchPublicationStore(f.directory, request)
  assert.equal((await store.publish(f.commit, { token: 'lease', context: f.context, shared: f.group.intent })).status, 'conflict')
  assert.match(f.server.getText('prose').toString(), /Peer shared wolf/)
  assert.equal(f.localHtml(), '<p>local wolf</p>')
})

test('two-owner mixed publication survives requester loss while updating the retained local owner', async t => {
  const f = await fixture(t)
  const store = new WritingSearchPublicationStore(f.directory, f.request)
  const local = new WritingDocumentRegistry({ context: { ...f.context, bookId: 'local-book', draftId: 'draft' }, isCurrent: () => true,
    transport: { read: async () => ({ html: '<p>local wolf</p>', hash: 'local' }), activate: async () => true, commit: async () => { throw new Error('Competing autosave') } } })
  const before = await local.read(f.localRef)
  const broker = new WritingSearchLeaseBroker((request, details) => store.publish(request, details))
  let release
  broker.register(1, request => queueMicrotask(() => broker.acknowledge(1, { token: request.token, stage: request.stage, documents: [] })))
  broker.register(2, request => { void (async () => {
    if (request.stage === 'prepare') release = await local.reserveExternal(request.token)
    if (request.stage === 'commit') local.acceptExternalCommit(request.token, request.changes.map(change => ({ ...change, before })))
    if (request.stage === 'release') release()
    broker.acknowledge(2, { token: request.token, stage: request.stage, documents: [{ current: before, saved: before }] })
  })() })
  const lease = await broker.acquire(1, f.context, [f.localRef, f.sharedRef])
  const publication = broker.publish(1, lease.token, f.commit, [{ ref: f.localRef, afterHtml: '<p>local fox</p>' }], f.group.intent)
  broker.remove(1)
  assert.equal((await publication).status, 'committed')
  assert.equal(local.capture()[0].html, '<p>local fox</p>')
  assert.match(f.server.getText('prose').toString(), /shared fox/)
  assert.equal(local.isDirty, false)
  await local.close()
})
