import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

function fixture(failure) {
  const events = []
  const context = { workspaceId: 'project', workspaceEpoch: 2, bookId: 'book', draftId: 'draft' }
  const owners = [{ context }]
  const lifecycle = loadRendererSource('src/stores/writingWorkspaceLifecycle.ts', {
    './writingDocuments': { getWritingRegistries: () => owners,
      prepareWritingDocumentClose: async () => { events.push('flush'); if (failure === 'registry' || failure === 'flush') throw new Error('pending'); return () => events.push('registry') } },
    './writingHistory': { assertWritingHistoriesAvailable: () => { events.push('preflight'); if (failure === 'history') throw new Error('busy') },
      prepareWritingHistoriesClose: () => { events.push('history-preflight'); return () => events.push('history') } },
    '../collaboration/sharedWritingAnnotations': { prepareSharedWritingAnnotationsClose: async () => { events.push('annotations-preflight'); if (failure === 'annotations') throw new Error('pending'); return () => events.push('annotations') } },
    '../collaboration/sharedWritingSessions': { prepareSharedWritingSessionsClose: async () => { events.push('sessions-preflight'); return () => events.push('sessions') } }
  })
  return { ...lifecycle, context, events }
}

test('preparing a switch drains documents but retains owners and undo until commit', async () => {
  const f = fixture()
  const close = await f.prepareWritingWorkspaceClose(f.context)
  assert.deepEqual(f.events, ['preflight', 'annotations-preflight', 'sessions-preflight', 'flush', 'history-preflight'])
  assert.equal(close(), undefined)
  assert.deepEqual(f.events.slice(-4), ['annotations', 'sessions', 'registry', 'history'])
})

test('failed preparation or release never disposes retained history', async () => {
  for (const failure of ['flush', 'history', 'annotations', 'registry']) {
    const f = fixture(failure)
    await assert.rejects(async () => { const close = await f.prepareWritingWorkspaceClose(f.context); await close() }, /pending|busy/)
    assert.equal(f.events.includes('history'), false)
    assert.equal(f.events.includes('annotations'), false)
    assert.equal(f.events.includes('sessions'), false)
    assert.equal(f.events.includes('registry'), false)
  }
})
