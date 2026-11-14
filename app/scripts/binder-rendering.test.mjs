import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { JSDOM } from 'jsdom'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  projectStore: `import { create } from 'zustand';
    export const useProjectStore = create(() => ({ projectPath: null, workspaceBusy: false, workspaceEpoch: 1,
      chapters: [{ guid: 'chapter', scenes: Array.from({ length: 64 }, (_, i) => ({ id: 's' + i, title: 'Scene ' + i,
        stage: 'draft', wordCount: i, order: i, plotlineColors: [], plotlineIds: [] })) }], openSceneId: 's0' }));
    export const useBookScope = () => 'book';`,
  shellStore: `import { create } from 'zustand'; export const BINDER_MAX = 500, BINDER_MIN = 100;
    export const panelWidthForShell = () => 300;
    export const useShellStore = create(() => ({ binderTab: 'chapters', mainView: 'manuscript' }));`,
  stageStore: `import { create } from 'zustand'; export const useStageStore = create(() => ({
    stages: [{ key: 'draft', label: 'Draft', color: 'red' }], load: async () => {} }));`,
  targetStore: `import { create } from 'zustand'; export const useTargetStore = create(() => ({
    targets: Array.from({ length: 64 }, (_, i) => ({ kind: 'scene', id: 's' + i, words: i, target: 100, overrun: 0 })), load: async () => {} }));`,
  narrationStore: `import { create } from 'zustand'; export const useNarrationStore = create(() => ({}));`,
  useIsPhone: 'export const useIsPhone = () => false;',
  binderNavigation: `export const openBinderScene = (chapterGuid, sceneId) => window.opened.push({ chapterGuid, sceneId });`,
  bookScopedLoad: 'export const loadBookScoped = async () => {};',
  sceneMetadataActions: 'export const setSceneMetadata = () => {};',
  writingStructure: 'export const executeWritingStructure = async command => window.commands.push(command);',
  client: `export const rpc = { request: async () => [] };`,
  ScenePresenceBadge: `export function ScenePresenceBadge({ sceneId }) { window.rendered.push(sceneId); return null; }`,
  'react-i18next': `import { create } from 'zustand';
    export const translations = create(() => ({ t: (key, values) => key + (values ? ':' + values.words : '') }));
    export const useTranslation = () => translations();`,
  'lucide-react': 'export const MoreHorizontal = () => null;'
}
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { useBinderState } from './src/renderer/src/shell/binderState'
  import { BinderSceneRow } from './src/renderer/src/shell/BinderSceneRow'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { useStageStore } from './src/renderer/src/stores/stageStore'
  import { useTargetStore } from './src/renderer/src/stores/targetStore'
  import { useSelectionStore } from './src/renderer/src/stores/selectionStore'
  import { translations } from 'react-i18next'
  let root, state
  function Binder() {
    state = useBinderState()
    return state.chapters.flatMap(chapter => chapter.scenes.map((scene, sceneIndex) =>
      <BinderSceneRow key={scene.id} state={state} chapter={chapter} scene={scene} sceneIndex={sceneIndex} />))
  }
  export async function mount() { await act(async () => { root = createRoot(document.getElementById('host')); root.render(<Binder />) }) }
  export async function close() { await act(async () => root.unmount()) }
  export async function navigate(id) { await act(async () => useProjectStore.setState({ openSceneId: id })) }
  export async function metadata(id, patch) { await act(async () => useProjectStore.setState(current => ({
    chapters: current.chapters.map(chapter => ({ ...chapter, scenes: chapter.scenes.map(scene => scene.id === id ? { ...scene, ...patch } : scene) })) }))) }
  export async function target(id, words) { await act(async () => useTargetStore.setState(current => ({
    targets: current.targets.map(target => target.id === id ? { ...target, words } : target) }))) }
  export async function stage() { await act(async () => useStageStore.setState({ stages: [{ key: 'draft', label: 'Revised', color: 'blue' }] })) }
  export async function select(ids) { await act(async () => useSelectionStore.getState().selectMany(ids)) }
  export async function changed(ids) { await act(async () => state.setChangedIds(new Set(ids))) }
  export async function sort(mode) { await act(async () => state.setSortMode(mode)) }
  export async function locale() { await act(async () => translations.setState({ t: key => 'translated:' + key })) }
  export async function event(index, name, options = {}) { await act(async () => document.querySelectorAll('.binder-scene-row')[index]
    .dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, ...options }))) }
  export function menu() { return state.menu }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'fixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'binder-dependencies', setup(builder) {
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }] })

async function fixture(t) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost', runScripts: 'outside-only' })
  const w = dom.window, channels = []
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.novalist = { isMobile: false }
  w.rendered = []; w.opened = []; w.commands = []
  w.eval(bundle.outputFiles[0].text)
  await w.fixture.mount()
  t.after(async () => { await w.fixture.close(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  w.rendered.length = 0
  return { w, api: w.fixture, row: i => w.document.querySelectorAll('.binder-scene-row')[i] }
}

test('active-scene navigation renders only the old and new Binder rows', async t => {
  const { w, api, row } = await fixture(t)
  await api.navigate('s1')
  assert.deepEqual([...w.rendered].sort(), ['s0', 's1'])
  assert.equal(row(0).classList.contains('active'), false)
  assert.equal(row(1).classList.contains('active'), true)
  w.rendered.length = 0
  await api.navigate('s2')
  assert.deepEqual([...w.rendered].sort(), ['s1', 's2'])
})

test('memoized Binder rows retain live metadata, targets, stages, selection and locale', async t => {
  const { w, api, row } = await fixture(t)
  await api.metadata('s3', { title: 'Renamed', inactive: true, plotlineColors: ['green'] })
  assert.deepEqual([...w.rendered], ['s3'])
  assert.equal(row(3).querySelector('.binder-scene-title').textContent, 'Renamed')
  assert.equal(row(3).classList.contains('inactive'), true)
  assert.equal(row(3).querySelector('.binder-thread-dot').style.background, 'green')
  w.rendered.length = 0
  await api.target('s3', 25)
  assert.deepEqual([...w.rendered], ['s3'])
  assert.match(row(3).textContent, /25\/100/)
  await api.stage()
  assert.equal(row(3).querySelector('.binder-scene-stage').title, 'Revised')
  await api.select(['s3'])
  await api.changed(['s4'])
  assert.equal(row(3).classList.contains('selected'), true)
  assert.equal(row(4).classList.contains('changed'), true)
  await api.locale()
  assert.equal(row(4).title, 'translated:explorer.changed')
})

test('row callbacks follow current selection, drag payload and sort mode', async t => {
  const { w, api, row } = await fixture(t)
  await api.event(3, 'click', { ctrlKey: true })
  assert.equal(row(3).classList.contains('selected'), true)
  await api.event(3, 'contextmenu', { clientX: 12, clientY: 24 })
  assert.equal(api.menu().sceneId, 's3')
  assert.equal(row(3).classList.contains('selected'), true)
  await api.select(['s3', 's4'])
  await api.event(3, 'dragstart')
  await api.event(8, 'drop')
  assert.deepEqual(JSON.parse(JSON.stringify(w.commands)), [{ kind: 'moveScenes', sceneIds: ['s3', 's4'], targetChapterGuid: 'chapter', beforeSceneId: 's8' }])
  await api.event(7, 'click')
  assert.deepEqual(JSON.parse(JSON.stringify(w.opened)), [{ chapterGuid: 'chapter', sceneId: 's7' }])
  assert.equal(row(3).classList.contains('selected'), false)
  await api.sort('title')
  assert.equal(row(3).draggable, false)
  await api.sort('order')
  assert.equal(row(3).draggable, true)
})
