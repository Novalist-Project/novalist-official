import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { loadRendererSource } from './renderer-source-loader.mjs'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const result = await build({ stdin: { contents: `
  export * from './src/renderer/src/collaboration/SharedSceneSession';
  export * from './src/renderer/src/stores/writingDocuments';
  export * from './src/shared/sceneSanitizer';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }

async function fixture(t) {
  const dom = new JSDOM('')
  dom.window.novalist = { isMobile: false }
  const peer = new Y.Doc()
  const prose = peer.getText('prose')
  prose.insert(0, 'First')
  prose.insert(5, '\n', { block: JSON.stringify([{ id: 'first', tag: 'p', attributes: {} }]) })
  const shared = { sessionId: 'session', itemId: 'item', state: Buffer.from(Y.encodeStateAsUpdate(peer)).toString('base64') }
  const purifiers = []
  const sessions = loadRendererSource('src/collaboration/sharedWritingSessions.ts', {
    dompurify: { default: window => { const purifier = createDOMPurify(window); purifiers.push(purifier); return purifier } }, '../../../shared/sceneSanitizer': module.exports,
    './SharedSceneSession': module.exports, './SharedEditorSession': {}, './richEditingSurface': {},
    './sharedDocuments': { decodeState: state => Uint8Array.from(Buffer.from(state, 'base64')),
      sharedDocumentConnection: () => ({ subscribe: () => () => {},
        read: async () => Y.encodeStateAsUpdate(peer), write: async update => Y.applyUpdate(peer, update) }) }
  }, { window: dom.window })
  const registry = new module.exports.WritingDocumentRegistry({ context, isCurrent: () => true,
    transport: { read: async () => ({ html: '<p>First</p>', hash: 'saved', shared }) } })
  const state = { isLoaded: true, openChapterGuid: ref.chapterGuid, openSceneId: ref.sceneId, getWritingRegistry: () => registry }
  const { writingSceneContextSource } = loadRendererSource('src/shell/writingSceneContext.ts', {
    '../collaboration/sharedWritingSessions': sessions
  }, { window: dom.window })
  await registry.read(ref)
  const source = writingSceneContextSource(() => state, ref.chapterGuid, ref.sceneId)
  t.after(async () => { await sessions.closeSharedWritingSessions(); await registry.close(); peer.destroy(); dom.window.close() })
  return { sessions, source, shared, peer, purifiers }
}

test('one thousand retained shared documents share one sanitizer while keeping prose and undo independent', async t => {
  const { sessions, shared, purifiers } = await fixture(t)
  const owners = Array.from({ length: 1000 }, (_, index) => sessions.getSharedWritingSession({ ...shared, itemId: `scene-${index}` }))
  assert.equal(purifiers.length, 1)
  assert.equal(new Set(owners.map(owner => owner.doc)).size, 1000)
  owners[0].transact(prose => prose.insert(0, 'Local '))
  assert.equal(owners[0].html, '<p>Local First</p>')
  assert.equal(owners[999].html, '<p>First</p>')
  assert.throws(() => owners[999].seedHtml('<p onclick="bad()">Unsafe</p>'), /canonical/)
  owners[0].undo()
  assert.equal(owners[0].html, '<p>First</p>')
  assert.equal(owners[999].html, '<p>First</p>')
  await owners[0].flush()
})

test('clean shared Context observers survive writing-surface detach and remount, then release the owner', async t => {
  const { sessions, source, shared, peer } = await fixture(t)
  const owner = sessions.getSharedWritingSession(shared)
  const seen = []
  const releaseContext = source.subscribe(() => seen.push(source.read()))
  const releaseStatus = source.subscribe(() => {})
  assert.equal(owner.dirty, false)
  assert.equal(owner.hasHistory, false)
  assert.equal(owner.releaseUnused(), false, 'leaving Write cannot discard the currently observed scene')
  assert.equal(sessions.getSharedWritingSession(shared), owner, 'returning to Write keeps the observed owner')
  peer.getText('prose').insert(0, 'Remote ')
  owner.receive(Y.encodeStateAsUpdate(peer))
  assert.equal(seen.at(-1), '<p>Remote First</p>')
  releaseContext()
  assert.equal(owner.releaseUnused(), false, 'the remaining StatusBar observer still owns a lease')
  const count = seen.length
  peer.getText('prose').insert(0, 'Next ')
  owner.receive(Y.encodeStateAsUpdate(peer))
  assert.equal(seen.length, count, 'unsubscribed Context no longer receives changes')
  releaseStatus()
  releaseStatus()
  assert.equal(owner.isClosed, true, 'the last clean observer releases the owner without waiting for another pane')
  assert.equal(sessions.findSharedWritingSession(shared), undefined)
})

test('local edits remain observable after a clean remount and observer cleanup preserves local undo', async t => {
  const { sessions, source, shared, peer } = await fixture(t)
  const seen = []
  const release = source.subscribe(() => seen.push(source.read()))
  const owner = sessions.getSharedWritingSession(shared)
  owner.releaseUnused()
  const remounted = sessions.getSharedWritingSession(shared)
  remounted.transact(prose => prose.insert(5, ' local'))
  await remounted.flush()
  assert.equal(seen.at(-1), '<p>First local</p>')
  assert.equal(peer.getText('prose').toString(), 'First local\n')
  release()
  assert.equal(remounted.isClosed, false, 'local undo remains retained after observer teardown')
  const count = seen.length
  remounted.undo()
  await remounted.flush()
  assert.equal(peer.getText('prose').toString(), 'First\n')
  assert.equal(seen.length, count)
})

test('observer cleanup removes the current session-map identity after a clean connection transfer', async t => {
  const { sessions, source, shared } = await fixture(t)
  const release = source.subscribe(() => {})
  const owner = sessions.getSharedWritingSession(shared)
  const transferred = { ...shared, sessionId: 'reconnected' }
  sessions.transferSharedWritingSession(shared, transferred)
  assert.equal(sessions.findSharedWritingSession(shared), undefined)
  assert.equal(sessions.findSharedWritingSession(transferred), owner)
  release()
  assert.equal(owner.isClosed, true)
  assert.equal(sessions.findSharedWritingSession(transferred), undefined)
})

test('observer cleanup leaves a mounted writing binding alive and clean visited owners do not accumulate', async t => {
  const { sessions, source, shared } = await fixture(t)
  const release = source.subscribe(() => {})
  const owner = sessions.getSharedWritingSession(shared)
  const detach = owner.bind({ setReadOnly() {}, capture() {}, isComposing: () => false,
    assertReady() {}, render() {}, prepare: () => undefined })
  release()
  assert.equal(owner.isClosed, false)
  detach()
  for (let visit = 0; visit < 20; visit++) {
    const identity = { ...shared, itemId: `visited-${visit}` }
    const unobserve = sessions.observeSharedWritingSession(identity, () => {})
    const visited = sessions.getSharedWritingSession(identity)
    unobserve()
    assert.equal(visited.isClosed, true)
    assert.equal(sessions.findSharedWritingSession(identity), undefined)
  }
})
