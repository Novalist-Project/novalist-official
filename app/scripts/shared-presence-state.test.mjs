import assert from 'node:assert/strict'
import test from 'node:test'
import { create } from 'zustand'
import { loadRendererSource } from './renderer-source-loader.mjs'

test('presence health publishes only actual transitions and preserves independent failures', () => {
  const { useHostedSessionStore: store } = loadRendererSource('src/collaboration/hostedSessionStore.ts', {
    zustand: { create }, '../rpc/client': { rpc: {} }, '../stores/hostBridgeStore': { useHostBridgeStore: {} }
  })
  store.setState({ session: { sessionId: 'active' } })
  const observed = []
  const unsubscribe = store.subscribe(state => observed.push(state))
  const initial = store.getState(), report = initial.reportPresence
  for (let scene = 0; scene < 1000; scene++) report('active', `scene-${scene}`, false)
  assert.equal(store.getState(), initial)
  assert.equal(observed.length, 0)
  report('active', 'first', true)
  const failed = store.getState()
  report('active', 'first', true)
  report('active', 'healthy', false)
  report('obsolete', 'second', true)
  assert.equal(store.getState(), failed)
  assert.equal(observed.length, 1)
  report('active', 'second', true)
  report('active', 'first', false)
  assert.deepEqual(Array.from(store.getState().presenceFailures), ['second'])
  assert.equal(store.getState().presenceUnavailable, true)
  report('active', 'second', false)
  assert.equal(store.getState().presenceUnavailable, false)
  assert.equal(observed.length, 4)
  unsubscribe()
})
