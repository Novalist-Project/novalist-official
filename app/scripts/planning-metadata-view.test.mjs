import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  projectStore: `import { create } from 'zustand';
    import { createProjectSceneActions } from './src/renderer/src/stores/projectSceneActions';
    export const useProjectStore = create((set, get) => ({ ...createProjectSceneActions(set, get),
      projectPath: 'project', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft',
      chapters: window.backend.chapters, applyState: state => set({ chapters: state.chapters }) }));
    export const useBookScope = () => useProjectStore(state => [state.projectPath, state.activeBookId, state.activeDraftId].join(':'));
    export const reconcileSceneEditors = () => ({});`,
  manuscriptStore: `import { create } from 'zustand'; export const useManuscriptStore = create(() => ({ composed: ['scene-0'] }));`,
  filterStore: `import { create } from 'zustand'; export const useFilterStore = create(() => ({
    filter: { status: '', character: '', location: '', plotline: '', stage: '' } }));`,
  sharedProjectNotifications: `export const useSharedProjectRevision = () => 0; export const registerSharedProjectNotifications = () => {};`,
  codexStore: `export const applySharedCodexField = () => {}; export const useCodexStore = { getState: () => ({}) };`,
  extensionsStore: `export const useExtensionsStore = { getState: () => ({ views: [] }) };`,
  shellStore: `export const useShellStore = { getState: () => ({}) };`,
  sceneContextData: `export const invalidateSceneContext = () => {};`,
  writingAnnotationNotifications: `export const registerWritingAnnotationNotifications = () => {};`,
  useWritingEntityNames: `const names = {}; export const useWritingEntityNames = () => ({ names, error: null });`,
  pendingWrites: `export const registerPendingWrite = () => () => {}; export const retainPendingWrite = () => {};
    export const flushPendingWrites = async () => {};`,
  writingStructure: `export const executeWritingStructure = async () => { throw Error('Unexpected structure command'); };`,
  i18n: `export default { t: key => key };`,
  'react-i18next': `export const useTranslation = () => ({ t: key => key });`,
  'lucide-react': `export const ChevronDown = () => null; export const ChevronRight = ChevronDown;
    export const GripVertical = ChevronDown; export const Move = ChevronDown; export const Plus = ChevronDown;
    export const Pencil = ChevronDown; export const Trash2 = ChevronDown;`,
  client: `const listeners = new Set(), notifications = new Map(); export const rpc = {
    onNotification: (method, listener) => notifications.set(method, listener),
    deliver: message => notifications.get(message.method)?.(message.params),
    onRequestCompleted: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (...args) => { const result = await window.request(...args); for (const listener of listeners) listener(args[0]); return result; }
  };`
}
for (const name of ['FilterBar', 'SceneBulkBar', 'PlanningToolbar', 'Corkboard', 'Outliner', 'Board',
  'InputDialog', 'ConfirmDialog', 'StructureMoveDialog', 'StructureRepair', 'SceneSynopsisField']) {
  sources[name] = `export const ${name} = () => null;`
}
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { PlanningView } from './src/renderer/src/views/manuscript/PlanningView'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { useFilterStore } from './src/renderer/src/stores/filterStore'
  import { useManuscriptStore } from './src/renderer/src/stores/manuscriptStore'
  import { rpc } from './src/renderer/src/rpc/client'
  import { useHostBridgeStore } from './src/renderer/src/stores/hostBridgeStore'
  import { BackendRouter } from './src/main/backend-router'
  import { encodeRpcFrame, RpcFrameDecoder } from './src/shared/rpcFraming'
  let root
  export async function mount() { await act(async () => {
    root = createRoot(document.getElementById('host')); root.render(<PlanningView onCommand={async () => {}} />)
  }) }
  export async function renameChapter(title) { await act(async () => useProjectStore.getState().renameChapter('chapter', title)) }
  export async function renameScene(title) { await act(async () => useProjectStore.getState().renameScene('chapter', 'scene-0', title)) }
  export async function describe(text) { await act(async () => rpc.request('project/setChapterDescription', ['chapter', text])) }
  export async function mutate(method, value) { await act(async () => rpc.request(method, ['chapter', 'scene-0', value])) }
  export async function remoteRename(title) { await act(async () => {
    const requests = [], decoder = new RpcFrameDecoder(), incoming = new RpcFrameDecoder()
    const router = new BackendRouter(frame => requests.push(...decoder.push(frame)))
    const main = { postMessage: frame => { for (const message of incoming.push(frame)) rpc.deliver(message) }, close() {} }
    const detached = { postMessage() {}, close() {} }
    router.setEpoch(1); router.attach(1, main); router.attach(2, detached)
    router.receive(2, detached, encodeRpcFrame({ jsonrpc: '2.0', id: 1, method: 'project/renameChapter', params: ['chapter', title] }))
    const result = await window.request('project/renameChapter', ['chapter', title])
    router.receiveBackend(encodeRpcFrame({ jsonrpc: '2.0', id: requests[0].id, result }))
    router.dispose()
  }) }
  export async function changeWorkspace() { await act(async () => {
    window.backend = { ...window.backend, bookId: 'next-book', chapters: [] }
    useProjectStore.setState({ activeBookId: 'next-book', workspaceEpoch: 2, chapters: [] })
  }) }
  export async function settle() { await act(async () => {}) }
  export async function sdkRename(title) { await act(async () => {
    window.backend.chapters[0].title = title
    rpc.deliver({ method: 'project/structureChanged', params: null })
  }) }
  export const errors = () => useHostBridgeStore.getState().toasts
  export async function stageFilter(stage) { await act(async () => {
    useManuscriptStore.setState({ composed: null });
    useFilterStore.setState({ filter: { status: '', character: '', location: '', plotline: '', stage } })
  }) }
  export async function editSummary(text) { await act(async () => {
    document.querySelector('.structure-chapter .structure-summary-preview').click()
  }); await act(async () => {
    const input = document.querySelector('.structure-chapter textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.setSelectionRange(3, 3)
  }) }
  export async function prose() { await act(async () => {
    for (let index = 0; index < 100; index++) {
      await rpc.request('writing/commit', [])
      await rpc.request('scenes/write', [])
      useProjectStore.setState(state => ({ chapters: state.chapters.map(chapter => ({ ...chapter,
        scenes: chapter.scenes.map(scene => ({ ...scene, wordCount: scene.wordCount + 1 })) })) }))
    }
  }) }
  export const epoch = () => useProjectStore.getState().workspaceEpoch
  export async function unmount() { if (root) await act(async () => { root.unmount(); root = null }) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'planningFixture', jsx: 'automatic',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'planning-dependencies', setup(builder) {
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }] })

async function fixture(t, count = 1) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, channels = [], calls = []
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.structuredClone = structuredClone
  w.novalist = { isMobile: false }
  w.backend = { bookId: 'book', draftId: 'draft', structureRevision: 'revision', issues: [],
    acts: [{ name: null, chapterGuids: ['chapter'], metadata: null }],
    chapters: [{ guid: 'chapter', title: 'Original chapter', description: 'Original summary', order: 0, act: '', status: '',
      scenes: Array.from({ length: count }, (_, order) => ({ id: 'scene-' + order, title: 'Original scene ' + order,
        order, wordCount: 10, synopsis: '', stage: 'draft', pov: 'Original POV', goal: '', outcome: '', properties: {},
        plotlineIds: [], inactive: false })) }] }
  let holdRead = false, release
  w.request = async (method, args) => {
    calls.push(method)
    if (method === 'planning/get') {
      const snapshot = structuredClone(w.backend)
      if (holdRead) { holdRead = false; return new Promise(resolve => { release = () => resolve(snapshot) }) }
      return snapshot
    }
    if (method === 'project/getState') return { chapters: structuredClone(w.backend.chapters) }
    const chapter = w.backend.chapters[0], scene = chapter.scenes[0]
    if (method === 'project/renameChapter') chapter.title = args[1]
    else if (method === 'project/renameScene') scene.title = args[2]
    else if (method === 'project/setChapterDescription') chapter.description = args[1]
    else if (method === 'stages/setSceneStage') scene.stage = args[2]
    else if (method === 'scenes/setPov') scene.pov = args[2]
    else if (method !== 'writing/commit' && method !== 'scenes/write') throw Error('Unexpected request: ' + method)
    return { chapters: structuredClone(w.backend.chapters) }
  }
  w.eval(bundle.outputFiles[0].text)
  const app = w.planningFixture
  await app.mount()
  t.after(async () => { await app.unmount(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  return { w, app, calls, holdRead: () => { holdRead = true }, release: () => release(),
    reads: () => calls.filter(method => method === 'planning/get').length }
}

test('mounted Structure follows same-epoch Binder renames, chapter description, stage and POV edits', async t => {
  const f = await fixture(t)
  const chapter = f.w.document.querySelector('.structure-chapter')
  assert.equal(chapter.querySelector('strong').textContent, 'Original chapter')
  await f.app.renameChapter('Renamed chapter')
  assert.equal(chapter.querySelector('strong').textContent, 'Renamed chapter')
  assert.equal(f.w.document.querySelector('.structure-chapter'), chapter, 'metadata refresh must not remount the chapter')
  await f.app.renameScene('Renamed scene')
  assert.equal(f.w.document.querySelector('.structure-scene-title').textContent, 'Renamed scene')
  await f.app.describe('Updated summary')
  assert.equal(chapter.querySelector('.structure-summary-preview').textContent, 'Updated summary')
  await f.app.mutate('scenes/setPov', 'New POV')
  assert.equal(f.w.document.querySelector('.structure-pov').textContent, 'New POV')
  await f.app.stageFilter('draft')
  await f.app.mutate('stages/setSceneStage', 'done')
  assert.equal(f.w.document.querySelectorAll('.structure-scene').length, 0)
  await f.app.stageFilter('done')
  assert.equal(f.w.document.querySelector('.structure-scene-title').textContent, 'Renamed scene')
  assert.equal(f.app.epoch(), 1)
  assert.equal(f.app.errors().length, 0)
})

test('a mounted metadata refresh preserves the focused unsaved chapter summary and caret', async t => {
  const f = await fixture(t)
  await f.app.editSummary('Unfinished summary')
  const input = f.w.document.querySelector('.structure-chapter textarea')
  await f.app.renameChapter('Renamed while writing')
  await f.app.describe('Other saved summary')
  assert.equal(f.w.document.querySelector('.structure-chapter strong').textContent, 'Renamed while writing')
  assert.equal(f.w.document.activeElement, input)
  assert.equal(input.value, 'Unfinished summary')
  assert.equal(input.selectionStart, 3)
})

test('100 prose saves and word-count updates never reload the 1000-scene planning snapshot', async t => {
  const f = await fixture(t, 1000)
  assert.equal(f.reads(), 1)
  await f.app.prose()
  assert.equal(f.reads(), 1)
  await f.app.unmount()
  await f.app.mutate('scenes/setPov', 'After unmount')
  assert.equal(f.reads(), 1, 'unmounted planning owns no mutation listener')
})

test('a detached-window metadata success updates mounted Plan through the real desktop router', async t => {
  const f = await fixture(t)
  await f.app.remoteRename('Renamed in detached window')
  assert.equal(f.w.document.querySelector('.structure-chapter strong').textContent, 'Renamed in detached window')
  assert.equal(f.app.epoch(), 1)
  assert.equal(f.reads(), 2)
})

test('a remote metadata read cannot publish after the mounted workspace changes', async t => {
  const f = await fixture(t)
  f.holdRead()
  await f.app.remoteRename('Departing workspace title')
  assert.equal(f.reads(), 2)
  await f.app.changeWorkspace()
  f.release()
  await f.app.settle()
  assert.equal(f.w.document.querySelectorAll('.structure-chapter').length, 0)
  assert.equal(f.app.errors().length, 0)
})

test('the existing SDK structure notification also refreshes the mounted planning snapshot', async t => {
  const f = await fixture(t)
  await f.app.sdkRename('Renamed by SDK')
  assert.equal(f.w.document.querySelector('.structure-chapter strong').textContent, 'Renamed by SDK')
  assert.equal(f.reads(), 2)
  assert.equal(f.app.errors().length, 0)
})
