import assert from 'node:assert/strict'
import test from 'node:test'
import { create } from 'zustand'
import { loadRendererSource } from './renderer-source-loader.mjs'

function fixture() {
  let workspace = { workspaceEpoch: 1, projectPath: 'first', workspaceBusy: false,
    workspaceSuspended: false, workspaceRecovering: false, workspaceTransitionToken: null }
  const requests = [], toasts = []
  const { useSteamInvitations } = loadRendererSource('src/collaboration/steamInvitations.ts', {
    zustand: { create },
    '../rpc/client': { rpc: { request: (method, params) => new Promise((resolve, reject) => requests.push({ method, params, resolve, reject })) } },
    '../stores/projectStore': { useProjectStore: { getState: () => workspace } },
    '../stores/hostBridgeStore': { useHostBridgeStore: { getState: () => ({ pushToast: message => toasts.push(message) }) } }
  })
  return { store: useSteamInvitations, requests, toasts, change: next => { workspace = { ...workspace, ...next } } }
}

for (const flag of ['workspaceBusy', 'workspaceSuspended', 'workspaceRecovering', 'workspaceTransitionToken']) {
  test(`invitation polling waits while ${flag} and resumes afterward`, async () => {
    const { store, requests, change } = fixture()
    change({ [flag]: flag === 'workspaceTransitionToken' ? 'transition' : true })
    const paused = store.getState().refresh()
    assert.equal(requests.length, 0)
    await paused
    change({ [flag]: flag === 'workspaceTransitionToken' ? null : false })
    const pending = store.getState().refresh()
    requests[0].resolve(null)
    await pending
    assert.equal(requests.length, 1)
  })
}

for (const changeTo of [{ workspaceEpoch: 2 }, { projectPath: 'second' }, { workspaceBusy: true }]) {
  test(`obsolete invitation results cannot show errors or replace current invitations: ${JSON.stringify(changeTo)}`, async () => {
    const { store, requests, toasts, change } = fixture()
    const failure = store.getState().refresh()
    const success = store.getState().refresh()
    change(changeTo)
    requests[0].reject(new Error('The workspace changed. Reload before retrying. (-32010)'))
    requests[1].resolve({ id: 'old', link: 'old-link', friendName: null, error: null })
    await Promise.all([failure, success])
    assert.deepEqual(toasts, [])
    assert.equal(store.getState().pollError, '')
    assert.equal(store.getState().pending, null)
  })
}

test('current invitation failures remain visible once and a successful poll clears the error', async () => {
  const { store, requests, toasts } = fixture()
  for (let index = 0; index < 2; index++) {
    const pending = store.getState().refresh()
    requests[index].reject(new Error('Steam service unavailable'))
    await pending
  }
  assert.deepEqual(toasts, ['Error: Steam service unavailable'])
  assert.equal(store.getState().pollError, toasts[0])
  const pending = store.getState().refresh()
  const invitation = { id: 'current', link: 'current-link', friendName: 'Friend', error: null }
  requests[2].resolve(invitation)
  await pending
  assert.equal(store.getState().pending, invitation)
  assert.equal(store.getState().pollError, '')
})
