import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

const { WritingDocumentRegistry } = loadRendererSource('src/stores/writingDocuments.ts', {
  './pendingWrites': { registerPendingWrite: () => () => {} }
}, { crypto, structuredClone })
const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }

function fixture(shared = null) {
  const listeners = new Set()
  const owner = { html: '<p>Shared live text</p>', isClosed: false,
    subscribe: changed => { listeners.add(changed); return () => listeners.delete(changed) } }
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => true,
    transport: { read: async () => ({ html: '<p>Saved</p>', hash: 'hash', shared }) } })
  const state = { isLoaded: true, openChapterGuid: 'chapter', openSceneId: 'scene', getWritingRegistry: () => registry }
  const { writingSceneContextSource } = loadRendererSource('src/shell/writingSceneContext.ts', {
    '../collaboration/sharedWritingSessions': { findSharedWritingSession: () => owner, getSharedWritingSession: () => owner,
      observeSharedWritingSession: (_, changed) => owner.subscribe(changed) }
  }, { window: { novalist: { isMobile: false } } })
  return { registry, state, owner, listeners, source: () => writingSceneContextSource(() => state, 'chapter', 'scene') }
}

test('context subscribes to passive loading and canonical edits without writing through legacy state', async () => {
  const f = fixture()
  const source = f.source(), seen = []
  assert.equal(source.read(), null)
  const release = source.subscribe(() => seen.push(source.read()))
  const before = await f.registry.read(ref)
  f.registry.apply({ id: 'edit', context, origin: 'writer', kind: 'input', annotationChanges: [],
    changes: [{ ref, expectedRevision: 0, beforeHtml: before.html, afterHtml: '' }],
    beforeSelection: null, afterSelection: null })
  assert.deepEqual(seen, ['<p>Saved</p>', ''])
  assert.equal(source.read(), '')
  release()
  f.registry.apply({ id: 'next', context, origin: 'writer', kind: 'input', annotationChanges: [],
    changes: [{ ref, expectedRevision: 1, beforeHtml: '', afterHtml: '<p>Next</p>' }],
    beforeSelection: null, afterSelection: null })
  assert.equal(seen.length, 2)
})

test('context follows shared owner notifications and releases both subscriptions', async () => {
  const f = fixture({ sessionId: 'session', itemId: 'item' })
  await f.registry.read(ref)
  const source = f.source(), seen = []
  const release = source.subscribe(() => seen.push(source.read()))
  f.owner.html = '<p>Remote edit</p>'
  for (const listener of f.listeners) listener()
  assert.deepEqual(seen, ['<p>Shared live text</p>', '<p>Remote edit</p>'])
  release()
  assert.equal(f.listeners.size, 0)
})

for (const patch of [{ workspaceBusy: true }, { workspaceSuspended: true }, { closingProject: true },
  { isLoaded: false }, { openChapterGuid: 'other' }, { openSceneId: 'other' }]) {
  test(`context cannot attach an obsolete scene during a workspace transition: ${JSON.stringify(patch)}`, () => {
    const f = fixture()
    const stale = f.source()
    Object.assign(f.state, patch, { getWritingRegistry() { assert.fail('must not acquire a stale owner') } })
    assert.equal(stale.read(), null, 'React may read the old subscription before its cleanup')
    assert.equal(f.source().read(), null)
    f.source().subscribe(() => assert.fail('must not subscribe'))()
  })
}
