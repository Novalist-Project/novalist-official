import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

function workspace(platform = 'android') {
  let receive
  const library = Promise.withResolvers()
  const refreshes = []
  let epoch = 0
  const state = {
    dirtyMap: {}, recentProjects: [], libraryStatus: 'ready',
    flushPendingSave() {}, refreshWorkspaceEditors() {}, applyState() {}, loadDrafts: async () => {},
    applyWorkspaceSnapshot(snapshot) { this.isLoaded = snapshot.state.isLoaded; this.workspaceEpoch = snapshot.epoch }
  }
  const project = { getState: () => state, setState: patch => Object.assign(state, patch), subscribe() {} }
  const settings = { getState: () => ({ load: async () => {} }) }
  const window = { novalist: { platform, isMobile: platform === 'android', beginProjectAccess: () => true,
    onWorkspaceEvent: callback => { receive = callback }
  } }
  const rpc = { onRecovery() {}, request: async (method, params) => {
    if (method === 'system/barrier') return
    if (method === 'project/recent') {
      refreshes.push(method)
      return library.promise
    }
    assert.ok(method === 'project/open' || method === 'project/close')
    const token = String(++epoch)
    const result = { isLoaded: method === 'project/open' && params[0] === '/valid' }
    await receive({ phase: 'prepare', preparation: { reason: method, token } })
    await receive({ phase: 'changed', snapshot: { token, epoch, state: result } })
    await receive({ phase: 'resumed', token, epoch })
    if (method === 'project/open' && !result.isLoaded) throw new Error('The selected folder is not a project.')
    return result
  } }
  const writes = { flushPendingWrites() {}, capturePendingWrites() {} }
  const actions = loadRendererSource('src/stores/projectLibraryActions.ts', {
    '../rpc/client': { rpc }, './settingsStore': { useSettingsStore: settings },
    './pendingWrites': writes, './projectStore': { useProjectStore: project },
    './projectSceneActions': { runSceneContext: action => action() }
  }, { window })
  Object.assign(state, actions.createProjectLibraryActions(project.setState, project.getState))
  const hook = loadRendererSource('src/shell/useWorkspaceWindow.ts', {
    react: { useEffect: setup => { setup() }, useState: () => [null, () => {}] },
    'react-dom': { flushSync: apply => apply() }, '../i18n': { default: { t: key => key } },
    '../rpc/client': { rpc }, '../stores/pendingWrites': writes,
    '../stores/projectStore': { useProjectStore: project, prepareProjectLibrary: actions.prepareProjectLibrary, reportEditingScenes() {} },
    '../stores/manuscriptStore': { useManuscriptStore: { getState: () => ({ flushPendingSave() {} }) }, resetManuscriptWorkspace() {} },
    '../stores/codexStore': {}, '../stores/settingsStore': { useSettingsStore: settings }, '../stores/hostBridgeStore': {},
    './useWorkspaceDialogGuard': { hasWorkspaceDialogDraft: () => false }, './useBackupScheduler': {},
    '../mobile/recovery': { restoreMobileRecovery() {} }, './hotkeys': { setHotkeysEnabled() {} },
    '../collaboration/hostedSessionStore': { useHostedSessionStore: { setState() {} } }
  }, { window, document: { querySelector: () => null } })
  hook.useWorkspaceWindow()
  return { state, library, refreshes }
}

test('a failed Android project open returns its own error while the library is still reading', async () => {
  const { state, library } = workspace()
  let error
  const opening = state.openProject('/selected').catch(failure => { error = failure })
  await new Promise(setImmediate)
  assert.match(error?.message ?? '', /selected folder is not a project/)
  assert.equal(state.workspaceBusy, false)
  assert.equal(state.libraryStatus, 'loading')
  library.reject(new Error('Folder unavailable'))
  await opening
  await new Promise(setImmediate)
  assert.equal(state.libraryStatus, 'failed')
})

test('an Android project closed locally refreshes the library once', async () => {
  const { state, library, refreshes } = workspace()
  const closing = state.closeProject()
  await new Promise(setImmediate)
  assert.equal(state.workspaceBusy, false)
  assert.equal(refreshes.length, 1)
  library.resolve([])
  await closing
  assert.equal(state.closingProject, false)
  assert.equal(refreshes.length, 1)
})

test('an old library failure leaves a newly opened Android workspace usable', async () => {
  const { state, library } = workspace()
  await assert.rejects(state.openProject('/selected'), /selected folder is not a project/)
  await state.openProject('/valid')
  const status = state.libraryStatus
  library.reject(new Error('Folder unavailable'))
  await new Promise(setImmediate)
  assert.equal(state.libraryStatus, status)
  assert.equal(state.isLoaded, true)
  assert.equal(state.workspaceBusy, false)
})

test('desktop still prepares the library before acknowledging the resumed workspace', async () => {
  const { state, library } = workspace('win32')
  const opening = assert.rejects(state.openProject('/selected'), /selected folder is not a project/)
  await new Promise(setImmediate)
  assert.equal(state.workspaceBusy, true)
  library.resolve([])
  await opening
  assert.equal(state.workspaceBusy, false)
})
