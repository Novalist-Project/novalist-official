import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

const { WritingServiceScheduler } = loadRendererSource('src/views/editor/writingServiceScheduler.ts', {}, { AbortController })
const state = (visibleSceneIds, extra = {}) => ({ visibleSceneIds, activeSceneId: null, composingSceneIds: [], selectedSceneIds: [], ...extra })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('services follow visibility and pinned scenes without accumulating across traversals', async () => {
  const active = new Set()
  const scheduler = new WritingServiceScheduler({ snapshot: sceneId => ({ sceneId, revision: 1, contextKey: 'epoch-1' }),
    start(request) { active.add(request.sceneId); return { dispose() { active.delete(request.sceneId) } } } })
  for (let round = 0; round < 5; round++) {
    for (let index = 0; index < 100; index++) {
      scheduler.update(state([`scene-${index}`], { composingSceneIds: ['composition'], selectedSceneIds: ['selection'] }))
      assert.equal(active.size, 3)
    }
  }
  await scheduler.dispose()
  assert.equal(active.size, 0)
})

test('stale revision and epoch results never publish after cancellation', async () => {
  let revision = 1
  let contextKey = 'epoch-1'
  const requests = []
  const publications = []
  const scheduler = new WritingServiceScheduler({ snapshot: sceneId => ({ sceneId, revision, contextKey }), start(request) {
    requests.push(request)
    return { dispose() {} }
  } })
  scheduler.update(state(['scene']))
  revision++
  scheduler.update(state(['scene']))
  assert.equal(requests[0].signal.aborted, true)
  requests[0].publish(() => publications.push('old-revision'))
  contextKey = 'epoch-2'
  scheduler.update(state(['scene']))
  requests[1].publish(() => publications.push('old-epoch'))
  requests[2].publish(() => publications.push('current'))
  assert.deepEqual(publications, ['current'])
  await scheduler.dispose()
  requests[2].publish(() => publications.push('disposed'))
  assert.deepEqual(publications, ['current'])
})

test('late async service creation is disposed and cannot survive a visibility change', async () => {
  let finish
  let disposed = 0
  const scheduler = new WritingServiceScheduler({ snapshot: sceneId => ({ sceneId, revision: 1, contextKey: 'epoch' }),
    start: () => new Promise(resolve => { finish = resolve }) })
  scheduler.update(state(['scene']))
  scheduler.update(state([]))
  finish({ dispose: () => { disposed++ } })
  await tick()
  assert.equal(disposed, 1)
  await scheduler.dispose()
})

test('proofing results cannot modify a scene while composition is pinned', async () => {
  let request
  let count = 0
  const scheduler = new WritingServiceScheduler({ snapshot: sceneId => ({ sceneId, revision: 1, contextKey: 'epoch' }),
    start(value) { request = value; return { dispose() {} } } })
  scheduler.update(state(['scene']))
  scheduler.update(state([], { composingSceneIds: ['scene'] }))
  assert.equal(request.publish(() => count++), false)
  scheduler.update(state(['scene']))
  assert.equal(request.publish(() => count++), true)
  assert.equal(count, 1)
  await scheduler.dispose()
})
