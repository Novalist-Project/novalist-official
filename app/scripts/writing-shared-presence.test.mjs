import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

test('shared presence follows visible scenes, publishes only the focused scene, and disposes on rebind', () => {
  const started = [], closed = []
  let focused = 'first'
  class Presence {
    constructor(identity, session, active) { started.push({ identity, session, active }) }
    close() { closed.push(this) }
  }
  const { WritingSharedPresence } = loadRendererSource('src/collaboration/WritingSharedPresence.ts', {
    './SharedEditorPresence': { SharedEditorPresence: Presence }
  })
  const tracker = new WritingSharedPresence(id => id === focused)
  const scene = id => ({ sceneId: id, identity: { sessionId: 'session', itemId: id, state: '', presence: true }, session: {} })
  const first = scene('first'), second = scene('second'), offscreen = scene('offscreen')
  tracker.update([first, second])
  assert.equal(started.length, 2)
  assert.equal(started[0].active(), true)
  assert.equal(started[1].active(), false)
  tracker.update([first, second])
  assert.equal(started.length, 2)
  focused = 'offscreen'
  tracker.update([second, offscreen])
  assert.equal(started.length, 3)
  assert.equal(closed.length, 1)
  assert.equal(started[1].active(), false)
  assert.equal(started[2].active(), true)
  tracker.update([{ ...offscreen, identity: { ...offscreen.identity, sessionId: 'reconnected' } }])
  assert.equal(started.length, 4)
  assert.equal(closed.length, 3)
  tracker.update([{ ...offscreen, identity: { ...offscreen.identity, presence: false } }])
  assert.equal(started.length, 4)
  assert.equal(closed.length, 4)
  tracker.close()
  tracker.close()
  assert.equal(closed.length, 4)
})
