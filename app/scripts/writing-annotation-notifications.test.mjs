import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'
import * as pendingWrites from '../src/renderer/src/stores/pendingWrites.ts'

const documents = loadRendererSource('src/stores/writingDocuments.ts', { './pendingWrites': pendingWrites }, { crypto, structuredClone })
const turn = () => new Promise(resolve => setImmediate(resolve))
const reference = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }

async function fixture(t, shared = false) {
  const context = { workspaceId: crypto.randomUUID(), workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const project = { projectPath: context.workspaceId, workspaceEpoch: 1, isLoaded: true }
  const environment = { novalist: { isMobile: false } }
  const annotations = { comments: [], footnotes: [] }
  let content = { html: 'Words', hash: 'saved', annotations,
    shared: shared ? { sessionId: 'session', itemId: 'item', state: '' } : null }
  let read = async () => content
  const owner = documents.getWritingDocumentRegistry({ context, isCurrent: () => true,
    transport: { read: () => read() } })
  await owner.read(reference)
  const errors = [], sharedReads = []
  let changed = 0
  const listeners = new Map()
  const { registerWritingAnnotationNotifications } = loadRendererSource('src/stores/writingAnnotationNotifications.ts', {
    './projectStore': { useProjectStore: { getState: () => project } },
    './writingDocuments': documents,
    './editorBridgeStore': { useEditorBridge: { getState: () => ({ annotationsChanged: () => changed++ }) } },
    '../collaboration/sharedWritingAnnotations': { refreshSharedWritingAnnotations: async (registry, refs) => sharedReads.push({ registry, refs }) }
  }, { window: environment })
  registerWritingAnnotationNotifications({ onNotification: (name, listener) => listeners.set(name, listener) }, error => errors.push(error))
  const notify = async (patch = {}) => { listeners.get('writing/annotationsChanged')([{ workspaceId: context.workspaceId, workspaceEpoch: 1, reference, ...patch }]); await turn() }
  t.after(() => documents.closeWritingDocumentRegistry(context))
  return { owner, context, project, environment, errors, sharedReads, notify, changed: () => changed,
    setAnnotations: next => { content = { ...content, annotations: next } }, setRead: next => { read = next } }
}

test('external annotation notification updates the real retained local scene and invalidates Inbox rows', async t => {
  const f = await fixture(t)
  const annotations = { comments: [{ id: 'imported', text: 'Review', anchorText: 'Words', resolved: false }], footnotes: [] }
  f.setAnnotations(annotations)
  await f.notify()
  assert.deepEqual(structuredClone(f.owner.getAnnotations(reference)), annotations)
  assert.equal(f.changed(), 1)
  assert.deepEqual(f.errors, [])
})

test('external annotation notification respects full identity, mobile, and obsolete replies', async t => {
  const f = await fixture(t)
  await f.notify({ workspaceId: 'other-project' })
  await f.notify({ workspaceEpoch: 0 })
  f.environment.novalist.isMobile = true
  await f.notify()
  assert.equal(f.changed(), 0)
  f.environment.novalist.isMobile = false
  let reject
  f.setRead(() => new Promise((_, fail) => { reject = fail }))
  await f.notify()
  f.project.workspaceEpoch++
  reject(new Error('obsolete read'))
  await turn()
  assert.deepEqual(f.errors, [])
  assert.equal(f.changed(), 0)
})

test('shared external annotations use the existing metadata owner and current failures stay visible', async t => {
  const shared = await fixture(t, true)
  await shared.notify()
  assert.equal(shared.sharedReads.length, 1)
  assert.equal(shared.sharedReads[0].registry, shared.owner)
  assert.deepEqual(structuredClone(shared.sharedReads[0].refs), [reference])
  const local = await fixture(t)
  local.setRead(async () => { throw new Error('read unavailable') })
  await local.notify()
  assert.equal(local.errors[0].message, 'read unavailable')
  assert.equal(local.changed(), 0)
})
