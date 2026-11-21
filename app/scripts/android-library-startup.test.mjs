import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

function startup(platform = 'android', loadSettings = async () => {}) {
  const response = Promise.withResolvers()
  let nextResponse = response
  const state = { isLoaded: false, recentProjects: [], libraryStatus: 'loading' }
  const project = { getState: () => state, setState: patch => Object.assign(state, patch) }
  const settings = { getState: () => ({ load: loadSettings, view: { global: { recentProjects: [{ name: 'Saved novel', path: '/novel' }] } } }) }
  const globals = { window: { novalist: { platform, workspaceSnapshot() {} } } }
  const rpc = { request: async method => {
    if (method === 'system/ping') return { version: 'test' }
    assert.equal(method, 'project/recent')
    return nextResponse.promise
  } }
  const dependencies = {
    '../rpc/client': { rpc }, './projectStore': { useProjectStore: project },
    './settingsStore': { useSettingsStore: settings }, './pendingWrites': {}, './projectSceneActions': {}
  }
  const { createProjectLibraryActions } = loadRendererSource('src/stores/projectLibraryActions.ts', dependencies, globals)
  Object.assign(state, createProjectLibraryActions(project.setState, project.getState))
  const { hydrateWindow } = loadRendererSource('src/shell/bootstrap.ts', {
    '../rpc/client': { rpc }, '../stores/projectStore': { useProjectStore: project },
    '../stores/settingsStore': { useSettingsStore: settings },
    '../stores/shellStore': { useShellStore: { getState: () => ({ setBackendVersion() {} }) } },
    '../stores/extensionsStore': { useExtensionsStore: { getState: () => ({ load() {} }) } },
    '../stores/userAssets': { loadUserAssets() {}, watchUserAssets() {} },
    './useWorkspaceWindow': { loadWorkspaceSnapshot() {} }
  }, globals)
  return { response, state, loading: hydrateWindow(), retry() {
    nextResponse = Promise.withResolvers()
    return { finished: hydrateWindow(), response: nextResponse }
  } }
}

test('Android shows saved projects while the provider is still reading books', async () => {
  const { state, response, loading } = startup()
  await new Promise(setImmediate)
  assert.equal(state.libraryStatus, 'loading')
  assert.equal(state.recentProjects[0]?.name, 'Saved novel')
  response.resolve([{ name: 'Renamed novel', path: '/novel', books: [{ id: 'vol2', name: 'Volume two' }] }])
  await loading
  assert.equal(state.libraryStatus, 'ready')
  assert.equal(state.recentProjects[0].books[0].id, 'vol2')
})

test('Android can retry a startup failure before the library request begins', async () => {
  let attempts = 0
  const { state, loading, retry } = startup('android', async () => {
    if (++attempts === 1) throw new Error('Settings unavailable')
  })
  await assert.rejects(loading, /Settings unavailable/)
  assert.equal(state.libraryStatus, 'failed')
  const second = retry()
  assert.equal(state.libraryStatus, 'loading')
  second.response.resolve([])
  await second.finished
  assert.equal(attempts, 2)
  assert.equal(state.libraryStatus, 'ready')
})

test('a failed Android library read retains saved projects and can be retried', async () => {
  const { state, response, loading, retry } = startup()
  response.reject(new Error('Provider unavailable'))
  await assert.rejects(loading, /Provider unavailable/)
  assert.equal(state.libraryStatus, 'failed')
  assert.equal(state.recentProjects[0]?.path, '/novel')
  const second = retry()
  assert.equal(state.libraryStatus, 'loading')
  second.response.resolve([])
  await second.finished
  assert.equal(state.libraryStatus, 'ready')
  assert.equal(state.recentProjects.length, 0)
})

test('desktop waits for the verified library before offering a stored path', async () => {
  const { state, response, loading } = startup('win32')
  await new Promise(setImmediate)
  assert.equal(state.recentProjects.length, 0)
  response.resolve([])
  await loading
  assert.equal(state.recentProjects.length, 0)
})
