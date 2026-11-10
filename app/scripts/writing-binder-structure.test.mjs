import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

const chapter = (guid, order, act, scenes = []) => ({ guid, order, act, scenes })
const chapters = () => [chapter('a1', 1, 'A'), chapter('a2', 2, 'A'), chapter('b1', 3, 'B'), chapter('b2', 4, 'B')]
function setup(isMobile = false, request = async () => ({ acts: [] })) {
  const calls = []
  let state = { chapters: chapters(), projectPath: 'project', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft', applyState: () => {} }
  const commands = loadRendererSource('src/stores/chapterStructureCommands.ts')
  const { createProjectSceneActions } = loadRendererSource('src/stores/projectSceneActions.ts', {
    '../rpc/client': { rpc: { request: async (method, args) => { calls.push({ method, args: structuredClone(args) }); return request(method, args) } } },
    './pendingWrites': {}, '../i18n': { default: { t: key => key } },
    './projectStore': { useProjectStore: { getState: () => state } },
    './writingStructure': { executeWritingStructure: async command => { calls.push(structuredClone(command)) } },
    './chapterStructureCommands': commands
  }, { window: { novalist: { isMobile } } })
  state = { ...state, ...createProjectSceneActions(patch => { state = { ...state, ...patch } }, () => state) }
  return { state, calls, update: patch => { state = { ...state, ...patch } } }
}

test('Binder chapter reorder adopts the destination act through one structural transaction', async () => {
  const { state, calls } = setup()
  await state.reorderChapter('a1', 3)
  assert.deepEqual(calls, [{ kind: 'moveChapters', chapterGuids: ['a1'], beforeChapterGuid: 'b2', targetActName: 'B' }])
})

test('changing chapter act joins the existing group without splitting either act', async () => {
  const { state, calls } = setup()
  await state.setChapterAct('b1', 'A')
  assert.deepEqual(calls, [{ kind: 'moveChapters', chapterGuids: ['b1'], beforeChapterGuid: 'b2', targetActName: 'A' }])
})

test('chapter boundary insertion inherits preceding act and named creation joins its group', async () => {
  const { state, calls } = setup()
  await state.createChapter('Boundary', 3)
  await state.createChapter('In A', undefined, 'A')
  assert.deepEqual(calls, [
    { kind: 'insertChapter', title: 'Boundary', beforeChapterGuid: 'b1', actName: 'A' },
    { kind: 'insertChapter', title: 'In A', beforeChapterGuid: 'b1', actName: 'A' }
  ])
})

test('dated chapter creation journals its date range in the same structural action', async () => {
  const { state, calls } = setup()
  const dateRange = { start: '2042-03-05', end: '2042-03-06', note: 'Arrival' }
  await state.createChapter('Dated', undefined, 'A', dateRange)
  assert.deepEqual(calls, [{ kind: 'insertChapter', title: 'Dated', beforeChapterGuid: 'b1', actName: 'A', dateRange }])
})

test('scene moves resolve full-order destinations after removing movers', async () => {
  const { state, calls } = setup()
  state.chapters[0].scenes = [{ id: 's1', order: 1 }, { id: 'hidden', order: 2 }, { id: 's3', order: 3 }]
  await state.reorderScene('a1', 's1', 3)
  await state.moveScenes(['s3'], 'a1', 0)
  assert.deepEqual(calls, [
    { kind: 'moveScenes', sceneIds: ['s1'], targetChapterGuid: 'a1', beforeSceneId: null },
    { kind: 'moveScenes', sceneIds: ['s3'], targetChapterGuid: 'a1', beforeSceneId: 's1' }
  ])
})

test('mobile chapter changes retain existing RPC contracts', async () => {
  const { state, calls } = setup(true)
  await state.reorderChapter('a1', 3)
  await state.setChapterAct('a1', 'Custom')
  await state.createChapter('Mobile', 2)
  assert.deepEqual(calls, [
    { method: 'project/reorderChapter', args: ['a1', 3] },
    { method: 'project/setChapterAct', args: ['a1', 'Custom'] },
    { method: 'project/createChapter', args: ['Mobile', 2] }
  ])
})

test('assigning and creating chapters in an empty act follows its declared position', () => {
  const commands = loadRendererSource('src/stores/chapterStructureCommands.ts')
  const acts = [{ name: 'Empty', chapterGuids: [] }, { name: 'A', chapterGuids: ['a1', 'a2'] }, { name: 'B', chapterGuids: ['b1', 'b2'] }]
  assert.deepEqual(structuredClone(commands.chapterActCommand(chapters(), 'b1', 'Empty', acts)), {
    kind: 'moveChapters', chapterGuids: ['b1'], beforeChapterGuid: 'a1', targetActName: 'Empty'
  })
  assert.deepEqual(structuredClone(commands.insertChapterCommand(chapters(), 'New', undefined, 'Empty', acts)), {
    kind: 'insertChapter', title: 'New', beforeChapterGuid: 'a1', actName: 'Empty'
  })
})

for (const operation of ['assign', 'create']) {
  test(`${operation} in an empty act reads ordered acts before submitting structure`, async () => {
    const f = setup(false, async () => ({ acts: [{ name: 'Empty', chapterGuids: [] }, { name: 'A', chapterGuids: ['a1', 'a2'] }] }))
    if (operation === 'assign') await f.state.setChapterAct('b1', 'Empty')
    else await f.state.createChapter('New', undefined, 'Empty')
    assert.deepEqual(f.calls[0], { method: 'planning/get', args: undefined })
    assert.equal(f.calls[1].beforeChapterGuid, 'a1')
  })
  test(`${operation} rejects a held act lookup after the active draft changes`, async () => {
    let resolve
    const gate = new Promise(done => { resolve = done })
    const f = setup(false, () => gate)
    const pending = operation === 'assign' ? f.state.setChapterAct('b1', 'Empty') : f.state.createChapter('New', undefined, 'Empty')
    f.update({ activeDraftId: 'other-draft' })
    resolve({ acts: [{ name: 'Empty', chapterGuids: [] }] })
    await assert.rejects(pending, /workspace|Workspace/)
    assert.deepEqual(f.calls, [{ method: 'planning/get', args: undefined }])
  })
}
