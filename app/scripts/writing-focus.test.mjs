import assert from 'node:assert/strict'
import test from 'node:test'
import { WritingFocusOwner } from '../src/main/writing-focus.ts'

test('only the actually focused window can claim a pane', async () => {
  const calls = []
  const focus = new WritingFocusOwner(async (method, params) => { calls.push([method, params]) }, () => 7)
  assert.equal(await focus.claim(8, 'pane', 4), null)
  const claim = await focus.claim(7, 'pane', 4)
  assert.deepEqual(claim, { sourceId: 'pane', focusGeneration: 1 })
  assert.deepEqual(calls, [['scenes/setFocusedWritingOwner', ['7', 'pane', 4, 1]]])
})

test('a delayed claim cannot reactivate a window after blur', async () => {
  let owner = 7
  let complete
  const calls = []
  const focus = new WritingFocusOwner(async (method, params) => {
    calls.push([method, params])
    if (params[0] === '7') await new Promise(resolve => { complete = resolve })
  }, () => owner)
  const pending = focus.claim(7, 'pane', 4)
  owner = 8
  await focus.release(7)
  complete()
  assert.equal(await pending, null)
  assert.deepEqual(calls[1], ['scenes/setFocusedWritingOwner', ['', '', 4, 2]])
})

test('invalid ownership input is rejected and unrelated window release is inert', async () => {
  const focus = new WritingFocusOwner(async () => {}, () => 7)
  await assert.rejects(focus.claim(7, '', 4))
  await assert.rejects(focus.claim(7, 'pane', -1))
  await focus.release(9)
  assert.deepEqual(await focus.claim(7, 'pane', 4), { sourceId: 'pane', focusGeneration: 1 })
})
