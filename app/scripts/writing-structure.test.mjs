import assert from 'node:assert/strict'
import test from 'node:test'
import { create } from 'zustand'
import { loadRendererSource } from './renderer-source-loader.mjs'

const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
const split = { kind: 'splitScene', ref, beforeHtml: '<p>A</p>', afterHtml: '<p>B</p>', sourceHtml: '<p>AB</p>', expectedHash: 'stale' }
function setup() {
  const calls = [], history = [], sharedCalls = []
  let hash = 'initial', shared = null
  const owner = { get context() { return { workspaceId: 'workspace', workspaceEpoch: project.getState().workspaceEpoch, bookId: 'book', draftId: 'draft' } },
    getSnapshot: () => ({ ...ref, html: '<p>AB</p>', hash }), capture: () => [ref] }
  const project = create(() => ({ projectPath: 'workspace', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft',
    getWritingRegistry: () => owner, setContextScene: (chapterGuid, sceneId) => project.setState({ openChapterGuid: chapterGuid, openSceneId: sceneId }) }))
  let respond = (_method, args) => ({ status: 'committed', operationId: typeof args[0] === 'string' ? args[0] : args[0].transactionId,
    state: {}, hashes: [], focusScene: { ...ref, sceneId: 'created' } })
  const subject = loadRendererSource('src/stores/writingStructure.ts', {
    '../i18n': { default: { t: key => key } },
    '../shell/useWorkspaceDialogGuard': { hasWorkspaceDialogDraft: () => false },
    zustand: { create }, '../rpc/client': { rpc: { request: async (method, args) => {
      calls.push({ method, args: structuredClone(args) })
      project.setState(state => ({ workspaceEpoch: state.workspaceEpoch + 1 }))
      return respond(method, args)
    } } }, './projectStore': { useProjectStore: project },
    './pendingWrites': { flushPendingWrites: async () => { hash = 'flushed' } },
    './writingHistory': { recordExternalWritingTransaction: (_owner, tx, inverse) => history.push({ tx, inverse }) },
    '../collaboration/sharedWritingStructure': { prepareSharedWritingStructure: async () => shared }
  }, { crypto, structuredClone, document: { querySelector: () => null } })
  return { ...subject, calls, history, project, sharedCalls, setResponse: value => { respond = value },
    enableShared: () => { shared = { expectedHash: 'shared-flushed', sharedSplit: { itemId: 'source', createdItemId: 'stable-child' },
      prepareRetry: async () => sharedCalls.push('reserve'), applied: () => sharedCalls.push('apply'), rejected: () => sharedCalls.push('release'), dispose: () => sharedCalls.push('dispose'),
      prepareUndo: async () => ({ update: 'inverse' }), prepareRedo: async () => ({ update: 'redo' }), appliedInverse: value => sharedCalls.push(value) } } }
}

test('structural split uses the flushed hash and attaches one asynchronous undo entry', async () => {
  const model = setup()
  await model.executeWritingStructure(split)
  assert.equal(model.calls[0].args[0].command.expectedHash, 'flushed')
  assert.equal(model.history.length, 1)
  const result = await model.history[0].inverse.undo()
  assert.equal(result.status, 'applied')
  assert.equal(model.calls[1].method, 'writing/undoStructure')
  assert.equal(model.calls[1].args[0], model.history[0].tx.id)
  assert.equal(model.calls[1].args[1], 2)
  assert.equal(model.project.getState().changingSceneStructure, false)
})

test('retry retains the shared split identity and command while refreshing the workspace epoch', async () => {
  const model = setup()
  model.enableShared()
  model.setResponse((_method, args) => model.calls.length === 1 ? { status: 'retryable', operationId: args[0].transactionId, errorCode: 'retry' } :
    { status: 'committed', operationId: args[0].transactionId, state: {}, hashes: [], focusScene: null })
  await assert.rejects(model.executeWritingStructure(split), /retry/)
  assert.equal(model.history.length, 0)
  assert.equal(model.useWritingStructureStatus.getState().pending.request.command.sharedSplit.createdItemId, 'stable-child')
  await model.retryWritingStructure()
  assert.equal(model.calls[0].args[0].transactionId, model.calls[1].args[0].transactionId)
  assert.deepEqual(model.calls[0].args[0].command, model.calls[1].args[0].command)
  assert.equal(model.calls[1].args[0].expectedEpoch, 2)
  assert.equal(model.calls[1].args[0].sharedSplit, undefined)
  assert.equal(model.history.length, 1)
  assert.deepEqual(model.sharedCalls, ['reserve', 'release', 'reserve', 'apply'])
})

test('a rejected structure leaves no successful undo entry or pending retry', async () => {
  const model = setup()
  model.enableShared()
  model.setResponse((_method, args) => ({ status: 'conflict', operationId: args[0].transactionId, errorCode: 'changed' }))
  await assert.rejects(model.executeWritingStructure(split), /changed/)
  assert.equal(model.history.length, 0)
  assert.equal(model.useWritingStructureStatus.getState().pending, null)
  assert.equal(model.project.getState().changingSceneStructure, false)
})
