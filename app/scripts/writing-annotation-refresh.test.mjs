import assert from 'node:assert/strict'
import test from 'node:test'
import { WritingAnnotationRefresh } from '../src/renderer/src/views/editor/writingAnnotationRefresh.ts'

const ref = sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('annotation refresh bounds reads to wanted scenes and coalesces changes while a read is pending', async () => {
  const calls = [], releases = []
  const reader = new WritingAnnotationRefresh(async refs => {
    calls.push(refs.map(value => value.sceneId))
    await new Promise(resolve => releases.push(resolve))
  }, error => assert.fail(String(error)))
  reader.update([ref('visible'), ref('active')], 1)
  for (let revision = 2; revision <= 1000; revision++) reader.update([ref('active'), ref('next')], revision)
  assert.deepEqual(calls, [['visible', 'active']])
  releases.shift()()
  await tick()
  assert.deepEqual(calls, [['visible', 'active'], ['active', 'next']])
  releases.shift()()
  await tick()
  reader.update([ref('active'), ref('next')], 1000)
  assert.equal(calls.length, 2)
  reader.update([ref('next'), ref('offscreen-until-now')], 1000)
  assert.deepEqual(calls[2], ['offscreen-until-now'])
  reader.dispose()
  releases.shift()()
  await tick()
  reader.update([ref('discarded')], 1001)
  assert.equal(calls.length, 3)
})

test('failed annotation refresh reports once and can be retried on the next update', async () => {
  let attempts = 0
  const errors = []
  const reader = new WritingAnnotationRefresh(async () => {
    if (++attempts === 1) throw new Error('offline')
  }, error => errors.push(error.message))
  reader.update([ref('active')], 1)
  await tick()
  assert.equal(attempts, 1)
  assert.deepEqual(errors, ['offline'])
  reader.update([ref('active')], 1)
  await tick()
  assert.equal(attempts, 2)
  reader.dispose()
})
