import assert from 'node:assert/strict'
import test from 'node:test'
import { create } from 'zustand'
import { loadRendererSource } from './renderer-source-loader.mjs'
import * as planningMetadata from '../src/shared/planningMetadata.ts'

const projection = loadRendererSource('src/stores/writingProjection.ts')
const loadRows = () => loadRendererSource('src/views/manuscript/structureProjection.ts', {
  '../../stores/writingProjection': projection
})
const emptyFilter = { status: '', character: '', location: '', plotline: '', stage: '' }
const scene = (id, order, stage = '') => ({ id, title: id, order, stage, plotlineIds: [], wordCount: 10, inactive: false })
const chapter = (guid, order, act, scenes = []) => ({ guid, order, title: guid, act, status: 'Draft', scenes })
const book = () => ({ bookId: 'book', draftId: 'draft', structureRevision: 'revision', issues: [], acts: [
  { name: 'Beginning', chapterGuids: ['first', 'empty-chapter'], metadata: { name: 'Beginning' } },
  { name: 'Empty act', chapterGuids: [], metadata: { name: 'Empty act' } },
  { name: null, chapterGuids: ['unassigned'], metadata: null }
], chapters: [chapter('first', 0, 'Beginning', [scene('one', 0, 'keep'), scene('hidden', 1), scene('last', 2, 'keep')]),
  chapter('empty-chapter', 1, 'Beginning'), chapter('unassigned', 2, '', [scene('inactive', 0)])] })

test('structure includes empty chapters, empty acts, unassigned groups and inactive scenes', () => {
  const { buildStructureRows } = loadRows()
  const state = book()
  state.chapters[2].scenes[0].inactive = true
  const rows = buildStructureRows(state, emptyFilter)
  assert.deepEqual(Array.from(rows.filter(row => row.kind === 'chapter'), row => row.chapter.guid), ['first', 'empty-chapter', 'unassigned'])
  assert.equal(rows.find(row => row.kind === 'act' && row.act.name === 'Empty act').act.chapterGuids.length, 0)
  assert.equal(rows.find(row => row.kind === 'scene' && row.scene.id === 'inactive').scene.inactive, true)
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length)
})

test('filtered rows retain full-order destinations and explicit selection overrides filters', () => {
  const { buildStructureRows } = loadRows()
  const { buildStructureMove } = loadRendererSource('src/views/manuscript/structureMoves.ts')
  const state = book()
  const rows = buildStructureRows(state, { ...emptyFilter, stage: 'keep' })
  assert.deepEqual(Array.from(rows.filter(row => row.kind === 'scene'), row => row.scene.id), ['one', 'last'])
  const destination = buildStructureMove(state, { kind: 'scenes', ids: ['inactive'] }, { kind: 'scene', chapterGuid: 'first', sceneId: 'one' }, 'after')
  assert.equal(destination.targetChapterGuid, 'first')
  assert.equal(destination.beforeSceneId, 'hidden')
  const selected = buildStructureRows(state, { ...emptyFilter, stage: 'keep' }, { selectedSceneIds: ['hidden'] })
  assert.deepEqual(Array.from(selected.filter(row => row.kind === 'scene'), row => row.scene.id), ['hidden'])
  assert.equal(buildStructureRows(state, emptyFilter, { selectedSceneIds: [] }).filter(row => row.kind === 'scene').length, 0)
})

test('collapsing groups only changes presentation and does not rewrite manuscript order', () => {
  const { buildStructureRows } = loadRows()
  const state = book()
  const before = structuredClone(state)
  const expanded = buildStructureRows(state, emptyFilter)
  const firstAct = expanded.find(row => row.kind === 'act' && row.act.name === 'Beginning')
  const collapsed = buildStructureRows(state, emptyFilter, { collapsed: new Set([firstAct.key]) })
  assert.equal(collapsed.some(row => row.kind === 'chapter' && row.chapter.guid === 'first'), false)
  assert.equal(collapsed.some(row => row.kind === 'chapter' && row.chapter.guid === 'unassigned'), true)
  assert.deepEqual(state, before)
})

test('planning loads metadata without prose and rejects a late previous-workspace response', async () => {
  const calls = []
  let complete
  const project = { projectPath: 'workspace', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft' }
  const { usePlanningStore } = loadRendererSource('src/stores/planningStore.ts', {
    '../../../shared/planningMetadata': planningMetadata,
    zustand: { create }, '../rpc/client': { rpc: { request(method) {
      calls.push(method)
      return new Promise(resolve => { complete = resolve })
    } } }, './projectStore': { useProjectStore: { getState: () => ({ ...project }) } },
    './manuscriptStore': { useManuscriptStore: { getState: () => ({}) } }
  })
  const first = usePlanningStore.getState().load()
  complete(book())
  await first
  assert.deepEqual(calls, ['planning/get'])
  assert.equal(usePlanningStore.getState().state.chapters.length, 3)
  const late = usePlanningStore.getState().load()
  project.workspaceEpoch++
  project.activeBookId = 'another-book'
  complete(book())
  await late
  assert.equal(usePlanningStore.getState().loading, false)
  assert.equal(usePlanningStore.getState().state, null)
})

test('moves resolve targets after removing movers and preserve full manuscript order', () => {
  const { buildStructureMove } = loadRendererSource('src/views/manuscript/structureMoves.ts')
  const state = book()
  assert.deepEqual(structuredClone(buildStructureMove(state, { kind: 'scenes', ids: ['last', 'one'] },
    { kind: 'chapter', chapterGuid: 'unassigned' }, 'inside')),
  { kind: 'moveScenes', sceneIds: ['one', 'last'], targetChapterGuid: 'unassigned', beforeSceneId: null })
  assert.deepEqual(structuredClone(buildStructureMove(state, { kind: 'chapters', ids: ['first'] },
    { kind: 'act', name: 'Empty act' }, 'inside')),
  { kind: 'moveChapters', chapterGuids: ['first'], targetActName: 'Empty act', beforeChapterGuid: 'unassigned' })
  assert.equal(buildStructureMove(state, { kind: 'scenes', ids: ['one'] }, { kind: 'scene', chapterGuid: 'first', sceneId: 'one' }, 'before'), null)
})
