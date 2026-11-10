import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

const reference = (sceneId, chapterGuid = 'chapter', bookId = 'book') => ({ bookId, draftId: 'draft', chapterGuid, sceneId })
const context = { workspaceId: 'workspace', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
function setup() {
  const ref = reference('scene')
  const before = { context, capture: () => [{ ...ref, html: 'old', hash: 'old-hash' }] }
  const calls = []
  const target = { context: { ...context, workspaceEpoch: 2 }, read: async reference => ({ ...reference, html: 'new', hash: 'new-hash' }) }
  const subject = loadRendererSource('src/stores/writingWorkspaceHistory.ts', {
    './writingDocuments': { sceneRefKey: ref => JSON.stringify([ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId]),
      getWritingRegistries: () => [before], closeWritingDocumentRegistry: async context => calls.push(['close', context.workspaceEpoch]) },
    './writingHistory': { getWritingHistoryReferences: () => [reference('removed')], rebindWritingHistory: (previous, next, changes) => calls.push(['rebind', previous, next, changes]) }
  })
  return { ...subject, calls, target, before }
}

test('workspace structure resumption verifies moved documents and keeps removed references dormant', async () => {
  const { captureWritingWorkspaceHistory, target, calls, before } = setup()
  const pending = captureWritingWorkspaceHistory(context)
  await pending.resume({ ...context, workspaceEpoch: 2 }, [{ guid: 'moved', scenes: [{ id: 'scene' }] }], () => target)
  assert.equal(calls[0][0], 'rebind')
  assert.equal(calls[0][1], before)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][3])), [
    { before: reference('scene'), after: reference('scene', 'moved'), expectedHtml: 'new', expectedHash: 'new-hash' },
    { before: reference('removed'), after: null }
  ])
  assert.deepEqual(calls[1], ['close', 1])
})

test('failed hydration preserves original history owners and refuses another project', async () => {
  const { captureWritingWorkspaceHistory, target, calls } = setup()
  const pending = captureWritingWorkspaceHistory(context)
  await assert.rejects(pending.resume({ ...context, workspaceId: 'other', workspaceEpoch: 2 }, [], () => target), /workspace/i)
  target.read = async () => { throw new Error('offline') }
  await assert.rejects(pending.resume({ ...context, workspaceEpoch: 2 }, [{ guid: 'moved', scenes: [{ id: 'scene' }] }], () => target), /offline/)
  assert.equal(calls.length, 0)
})
