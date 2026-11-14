import assert from 'node:assert/strict'
import test from 'node:test'
import { create } from 'zustand'
import { loadRendererSource } from './renderer-source-loader.mjs'

const empty = { status: '', character: '', location: '', plotline: '', stage: '' }
const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
const chapters = [{ guid: 'c', order: 0, status: '', scenes: [
  { id: 's', order: 0, stage: 'draft', plotlineIds: [] }, { id: 'next', order: 1, stage: 'revised', plotlineIds: [] }
] }]
function fixture(selectedSceneIds = null, filter = empty) {
  const selected = create(() => ({ composed: selectedSceneIds, filterListId: 'list' }))
  const filters = create(set => ({ filter, clear: () => set({ filter: empty }) }))
  const methods = loadRendererSource('src/stores/writingSceneNavigation.ts', {
    './manuscriptStore': { useManuscriptStore: selected }, './filterStore': { useFilterStore: filters },
    './writingProjection': loadRendererSource('src/stores/writingProjection.ts'),
    '../views/editor/writingNavigation': { getWritingNavigation: () => null },
    '../rpc/client': { rpc: { request: async () => [] } }
  })
  return { ...methods, selected, filters }
}

test('navigation widens explicit empty or stale selections but keeps matching filters', async () => {
  const ref = { ...context, chapterGuid: 'c', sceneId: 'next' }
  for (const selection of [[], ['stale']]) {
    const f = fixture(selection)
    await f.widenWritingRunForScene(context, chapters, ref)
    assert.equal(f.selected.getState().composed, null)
  }
  const f = fixture(null, { ...empty, stage: 'revised' })
  await f.widenWritingRunForScene(context, chapters, ref)
  assert.equal(f.filters.getState().filter.stage, 'revised')
  await f.widenWritingRunForScene(context, chapters, { ...ref, sceneId: 's' })
  assert.equal(f.filters.getState().filter.stage, '')
})

test('navigation cannot widen a run for a stale scene or foreign book', async () => {
  const f = fixture([])
  await f.widenWritingRunForScene(context, chapters, { ...context, chapterGuid: 'c', sceneId: 'missing' })
  assert.deepEqual(f.selected.getState().composed, [])
  await f.widenWritingRunForScene(context, chapters, { ...context, bookId: 'other', chapterGuid: 'c', sceneId: 's' })
  assert.deepEqual(f.selected.getState().composed, [])
})
