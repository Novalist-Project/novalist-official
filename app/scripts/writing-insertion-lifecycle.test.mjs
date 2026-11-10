import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({})); export const reportEditingScenes = () => {}; export const prepareProjectLibrary = async () => {};`,
  shellStore: `export const useShellStore = { getState: () => ({ activePaneId: 'writer' }) };`,
  client: `export const rpc = { request: (...args) => window.request(...args), onRecovery: () => () => {} };`,
  i18n: `export default { t: key => key };`,
  'react-i18next': `export const useTranslation = () => ({ t: key => key });`,
  MotionPresence: `export const useMotionPresent = () => true;`,
  useDialogKeyboard: `export const useDialogAutoFocus = () => {}; export const useDialogKeyboard = () => ({});`,
  writingError: `export const writingErrorMessage = reason => String(reason);`,
  writingNavigation: `export const getWritingNavigation = () => ({ capture: () => {} });`,
  editorBridge: `export const editorWindow = () => null;`,
  sharedWritingStructure: `export const prepareSharedWritingStructure = async () => null;`,
  writingHistory: `export const recordExternalWritingTransaction = () => {};`,
  writingWorkspaceHistory: `export const captureWritingWorkspaceHistory = () => ({ resume: async () => {} });`,
  writingWorkspaceLifecycle: `export const prepareWritingWorkspaceClose = async () => () => {};`,
  writingDocuments: `export const getWritingWorkspaceRegistries = () => [];`,
  writingSearchLease: `export const rebaseWritingSearchLeases = () => {}; export const validateWritingSearchRecovery = () => {};`,
  writingWorkspaceRecovery: `export const prepareWritingWorkspaceRecovery = async () => null;`,
  manuscriptStore: `export const hasPendingManuscriptWrites = () => false; export const resetManuscriptWorkspace = () => {}; export const useManuscriptStore = { getState: () => ({ flushPendingSave: async () => {} }) };`,
  codexStore: `export const useCodexStore = { getState: () => ({ refresh: async () => {} }) };`,
  settingsStore: `export const useSettingsStore = { getState: () => ({ load: async () => {} }) };`,
  hostBridgeStore: `export const useHostBridgeStore = { getState: () => ({ pushToast: message => window.events.push(['toast', message]) }) };`,
  useBackupScheduler: `export const clearCloseBackupHandledForQuit = () => {}; export const createCloseBackup = async () => {}; export const markCloseBackupHandledForQuit = () => {};`,
  recovery: `export const captureMobileRecovery = () => []; export const clearAcknowledgedRecovery = () => {}; export const restoreMobileRecovery = async () => {}; export const reportRecoveryError = () => {};`,
  hotkeys: `export const setHotkeysEnabled = () => {};`,
  hostedSessionStore: `export const useHostedSessionStore = { setState: () => {} };`
}
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { WritingMetadataName } from './src/renderer/src/views/editor/WritingMetadataName'
  import { WritingStructureHost } from './src/renderer/src/views/editor/WritingStructureHost'
  import { useWorkspaceWindow, flushWindowWrites } from './src/renderer/src/shell/useWorkspaceWindow'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { registerPendingWrite } from './src/renderer/src/stores/pendingWrites'
  import { hasWorkspaceDialogDraft } from './src/renderer/src/shell/useWorkspaceDialogGuard'
  import { executeWritingStructure, useWritingStructureStatus } from './src/renderer/src/stores/writingStructure'
  let root, stop
  function App({ context, label }) {
    useWorkspaceWindow()
    return <><WritingMetadataName value="Opening" label={label} context={context} structural={label === 'Act name'}
      save={async value => {
        if (label === 'Act name') await executeWritingStructure({ kind: 'renameAct', oldName: 'Opening', newName: value })
        window.events.push(['rename', label, value])
      }} /><WritingStructureHost /></>
  }
  export async function mount(label) {
    const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
    const owner = { get context() { return { ...context, workspaceEpoch: useProjectStore.getState().workspaceEpoch } }, capture: () => [] }
    useProjectStore.setState({ projectPath: 'project', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft', isLoaded: true,
      chapters: [{ guid: 'chapter', order: 0, act: '', scenes: [{ id: 'scene' }] }], editors: {}, dirtyMap: {},
      getWritingRegistry: () => owner, flushPendingSave: async () => {}, refreshWorkspaceEditors: async () => {},
      loadRecents: async () => {}, loadDrafts: async () => {}, setContextScene: () => {},
      applyWorkspaceSnapshot: snapshot => useProjectStore.setState({ workspaceEpoch: snapshot.epoch }) })
    stop = registerPendingWrite(async () => { window.savedProse = window.liveProse })
    window.request = async (method, args) => {
      if (method !== 'writing/structure') return
      const token = 'insertion'
      try { await window.workspaceEvent({ phase: 'prepare', preparation: { token, reason: method } }) }
      catch (error) { await window.workspaceEvent({ phase: 'aborted', token }); throw Error(error.message + ' (-32010)') }
      window.events.push(['insert', args[0].command.kind])
      await window.workspaceEvent({ phase: 'changed', snapshot: { epoch: 2 } })
      await window.workspaceEvent({ phase: 'resumed', token })
      return { status: 'committed', operationId: args[0].transactionId, state: {}, hashes: [], focusScene: null }
    }
    root = createRoot(document.getElementById('host'))
    await act(async () => root.render(<App context={context} label={label} />))
  }
  export const guarded = hasWorkspaceDialogDraft
  export const status = () => useWritingStructureStatus.getState()
  export async function click(element) { await act(async () => element.click()) }
  export async function input(element, value) { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  export async function command(command) { await act(async () => executeWritingStructure(command)) }
  export async function insert() { await act(async () => window.dispatchEvent(new CustomEvent('novalist:writing-structure', {
    detail: { command: 'insertScene', selection: null, anchor: null, sceneDestination: { chapterGuid: 'chapter', beforeSceneId: null }, paneId: 'writer' }
  }))) }
  export async function close() { await act(async () => { await flushWindowWrites(); await window.beforeClose('flush'); await window.beforeClose('abort') }) }
  export async function unmount() { stop(); await act(async () => root.unmount()) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'fixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, plugins: [{ name: 'lifecycle-host', setup(builder) {
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }] })

async function fixture(t, label = 'Scene name') {
  const dom = new JSDOM('<div class="shell"><div id="host"></div></div>', { url: 'http://localhost', runScripts: 'outside-only' })
  const w = dom.window, channels = []
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.HTMLElement.prototype.scrollIntoView = function () { w.revealed = this }
  w.novalist = { isMobile: false, onWorkspaceEvent: listener => { w.workspaceEvent = listener }, onBeforeClose: listener => { w.beforeClose = listener } }
  w.events = []; w.liveProse = 'Unsaved manuscript prose'; w.savedProse = ''
  w.eval(bundle.outputFiles[0].text)
  const app = w.fixture
  await app.mount(label)
  t.after(async () => { await app.unmount(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  return { w, app }
}

test('inline scene insertion drains prose and permits subsequent save and close', async t => {
  const { w, app } = await fixture(t)
  await app.insert()
  assert.equal(w.events.filter(event => event[0] === 'insert').length, 1)
  assert.equal(w.savedProse, w.liveProse)
  assert.equal(app.status().error, null)
  await app.close()
})

for (const label of ['Scene name', 'Chapter name', 'Act name']) test(`opening an unchanged ${label} must not block inline insertion, saving, or closing`, async t => {
  const { w, app } = await fixture(t, label)
  await app.click(w.document.querySelector(`[aria-label="${label}"]`))
  await app.insert()
  assert.equal(w.events.filter(event => event[0] === 'insert').length, 1)
  assert.equal(w.savedProse, w.liveProse)
  assert.equal(app.status().error, null)
  await app.close()
})

for (const label of ['Scene name', 'Chapter name', 'Act name']) test(`a changed ${label} is revealed and retained when insertion or close is blocked`, async t => {
  const { w, app } = await fixture(t, label)
  await app.click(w.document.querySelector(`[aria-label="${label}"]`))
  const input = w.document.querySelector('input')
  await app.input(input, 'Retained changed name')
  input.blur()
  await app.insert()
  assert.equal(w.events.filter(event => event[0] === 'insert').length, 0)
  assert.match(w.document.querySelector('.writing-structure-error').textContent, /unifiedWriting.finishMetadataEdit/)
  assert.equal(app.status().pending, null, 'a local draft veto does not reserve a retry that blocks saving the name')
  assert.equal(w.document.activeElement, input)
  assert.equal(w.revealed, input)
  assert.equal(input.value, 'Retained changed name')
  assert.equal(w.liveProse, 'Unsaved manuscript prose')
  assert.equal(app.guarded(), true)
  input.blur()
  await assert.rejects(app.close(), /unifiedWriting.finishMetadataEdit/)
  assert.equal(w.document.activeElement, input)
  assert.equal(input.value, 'Retained changed name')
  await app.click([...w.document.querySelectorAll('button')].find(button => button.textContent === 'dialog.cancel'))
  assert.equal(app.guarded(), false)
  await app.insert()
  assert.equal(w.events.filter(event => event[0] === 'insert').length, 1)
  assert.equal(w.savedProse, w.liveProse)
  await app.close()
})

test('a changed act name can be saved after insertion was vetoed, then insertion and close succeed', async t => {
  const { w, app } = await fixture(t, 'Act name')
  await app.click(w.document.querySelector('[aria-label="Act name"]'))
  await app.input(w.document.querySelector('input'), 'Changed act')
  await app.insert()
  assert.equal(app.status().pending, null)
  await app.click([...w.document.querySelectorAll('button')].find(button => button.textContent === 'dialog.save'))
  assert.equal(w.events.some(event => event[0] === 'rename' && event[2] === 'Changed act'), true)
  assert.equal(app.guarded(), false)
  await app.insert()
  assert.equal(w.events.filter(event => event[0] === 'insert' && event[1] === 'insertScene').length, 1)
  assert.equal(w.savedProse, w.liveProse)
  await app.close()
})

for (const command of [
  { kind: 'insertChapter', title: 'New chapter', beforeChapterGuid: null, actName: null },
  { kind: 'createAct', name: 'New act', beforeActName: null }
]) test(`${command.kind} rejects a pending name before reserving a transaction and succeeds after cancel`, async t => {
  const { w, app } = await fixture(t, 'Chapter name')
  await app.click(w.document.querySelector('[aria-label="Chapter name"]'))
  await app.input(w.document.querySelector('input'), 'Changed chapter')
  await assert.rejects(app.command(command), /unifiedWriting.finishMetadataEdit/)
  assert.equal(app.status().pending, null)
  await app.click([...w.document.querySelectorAll('button')].find(button => button.textContent === 'dialog.cancel'))
  await app.command(command)
  assert.equal(w.events.some(event => event[0] === 'insert' && event[1] === command.kind), true)
  await app.close()
})
