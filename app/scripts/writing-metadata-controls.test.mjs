import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({}));`,
  stageStore: `import { create } from 'zustand'; export const useStageStore = create(() => ({ stages: [], setSceneStage: (...args) => window.mutate('stage', args) }));`,
  useWritingCanvas: `export const useWritingChromeTargets = () => window.targets;`,
  writingStructure: `export const executeWritingStructure = command => window.mutate('structure', command);`,
  SceneSynopsisField: `export const SceneSynopsisField = () => null;`,
  sharedWritingSessions: `export const getSharedWritingSession = () => { throw Error('Unexpected prose owner'); };`,
  metadataCommands: `export const writeSharedMetadata = (binding, value) => window.mutate('shared', { binding, value });`,
  hostBridgeStore: `export const useHostBridgeStore = { getState: () => ({ pushToast: message => window.toasts.push(message) }) };`,
  client: `export const rpc = { request: () => { throw Error('Unexpected RPC'); } };`,
  i18n: `export default { t: key => key };`
}
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { createInstance } from 'i18next'
  import { I18nextProvider } from 'react-i18next'
  import en from './src/renderer/src/locales/en.json'
  import { WritingCanvasChrome } from './src/renderer/src/views/editor/WritingCanvasChrome'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { useStageStore } from './src/renderer/src/stores/stageStore'
  import { registerPendingWrite } from './src/renderer/src/stores/pendingWrites'
  import { hasWorkspaceDialogDraft } from './src/renderer/src/shell/useWorkspaceDialogGuard'
  let root, props
  export async function mount(shared) {
    const scene = { id: 'scene', title: 'Opening scene', wordCount: 12, stage: 'draft',
      ...(shared ? { sharedFields: { sessionId: 'session', fields: { title: 'title-field' } } } : {}) }
    const chapter = { guid: 'chapter', title: 'Opening chapter', act: 'First act', order: 0, scenes: [scene] }
    const context = { workspaceId: '/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
    const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
    useProjectStore.setState({ projectPath: '/project', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft', chapters: [chapter],
      renameScene: (...args) => window.mutate('scene', args), renameChapter: (...args) => window.mutate('chapter', args) })
    useStageStore.setState({ stages: [{ key: 'draft', label: 'Draft', color: 'blue' }, { key: 'revised', label: 'Revised', color: 'green' }] })
    window.targets = { targets: [{ scene: ref, element: document.getElementById('chrome') }], emptyTargets: [], endTarget: null, introTarget: document.getElementById('intro') }
    const registry = { context, subscribe: () => () => {}, getSnapshot: () => undefined }
    props = { live: null, registry, snapshots: [ref], chapters: [chapter], scope: 'manuscript', revision: 1, limited: false,
      narrow: false, showSynopsis: false, bookTitle: 'Book title', draftName: 'Draft 1', onStructure() {}, onFocusScene() {} }
    const i18n = createInstance(); await i18n.init({ lng: 'en', resources: { en: { translation: en } } })
    root = createRoot(document.getElementById('host'))
    await act(async () => root.render(<I18nextProvider i18n={i18n}><WritingCanvasChrome {...props} /></I18nextProvider>))
  }
  export const guarded = hasWorkspaceDialogDraft
  export const pending = registerPendingWrite
  export const switchWorkspace = () => useProjectStore.setState({ activeBookId: 'other-book' })
  export async function click(element) { await act(async () => element.click()) }
  export async function input(element, value) { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  export async function select(element, value) { await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) }) }
  export async function unmount() { await act(async () => root.unmount()) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'metadataFixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'text' },
  plugins: [{ name: 'metadata-host', setup(builder) {
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }] })

async function fixture(t, shared = false) {
  const dom = new JSDOM('<div id="host"></div><div id="intro"></div><div id="chrome"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, mutations = [], channels = []
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.toasts = []
  w.mutate = async (kind, args) => { mutations.push({ kind, args }); return true }
  w.eval(bundle.outputFiles[0].text)
  const app = w.metadataFixture
  t.after(async () => { await app.unmount(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  await app.mount(shared)
  const button = label => [...w.document.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent === label)
  return { w, app, mutations, button }
}

test('scene name and editable stage live in the rail; chapter and act names edit at their heading', async t => {
  const f = await fixture(t)
  assert.equal(f.w.document.querySelector('.writing-scene-margin .writing-metadata-name')?.textContent, 'Opening scene')
  assert.equal(f.w.document.querySelector('.writing-book-heading .writing-eyebrow'), null)
  assert.equal(f.w.document.querySelector('.writing-book-heading h1').textContent, 'Book title')
  for (const [label, value, kind] of [['Scene name', 'Renamed scene', 'scene'], ['Chapter name', 'Renamed chapter', 'chapter'], ['Rename act', 'Renamed act', 'structure']]) {
    await f.app.click(f.button(label))
    assert.equal(f.app.guarded(), false)
    await f.app.input(f.w.document.querySelector('.writing-metadata-input'), value)
    assert.equal(f.app.guarded(), true)
    await f.app.click(f.button('Save'))
    assert.equal(f.mutations.at(-1).kind, kind)
    if (kind === 'structure') assert.deepEqual(JSON.parse(JSON.stringify(f.mutations.at(-1).args)), { kind: 'renameAct', oldName: 'First act', newName: value })
    else assert.equal(f.mutations.at(-1).args.at(-1), value)
    assert.equal(f.app.guarded(), false)
  }
  const stage = f.w.document.querySelector('.writing-scene-margin select')
  await f.app.select(stage, 'revised')
  assert.deepEqual(JSON.parse(JSON.stringify(f.mutations.at(-1))), { kind: 'stage', args: ['chapter', 'scene', 'revised'] })
  await f.app.select(stage, '')
  assert.equal(f.mutations.at(-1).args.at(-1), null)
})

test('failed pending prose prevents rename and leaves the name draft visible for retry', async t => {
  const f = await fixture(t)
  const stop = f.app.pending(() => { throw Error('Prose save failed') })
  await f.app.click(f.button('Scene name'))
  await f.app.input(f.w.document.querySelector('.writing-metadata-input'), 'Retained name')
  await f.app.click(f.button('Save'))
  assert.equal(f.mutations.length, 0)
  assert.equal(f.w.document.querySelector('.writing-metadata-input').value, 'Retained name')
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Prose save failed/)
  stop()
  await f.app.click(f.button('Save'))
  assert.equal(f.mutations[0].args.at(-1), 'Retained name')
})

test('shared scene title uses its field binding and refused publication retains the draft', async t => {
  const f = await fixture(t, true)
  f.w.mutate = async (kind, args) => { f.mutations.push({ kind, args }); return false }
  await f.app.click(f.button('Scene name'))
  await f.app.input(f.w.document.querySelector('.writing-metadata-input'), 'Shared name')
  await f.app.click(f.button('Save'))
  assert.equal(f.mutations[0].kind, 'shared')
  assert.deepEqual(JSON.parse(JSON.stringify(f.mutations[0].args)), { binding: { sessionId: 'session', itemId: 'title-field' }, value: 'Shared name' })
  assert.equal(f.w.document.querySelector('.writing-metadata-input').value, 'Shared name')
  assert.ok(f.w.document.querySelector('[role="alert"]'))
  await f.app.click(f.button('Cancel'))
  assert.equal(f.app.guarded(), false)
})

test('stage failures are visible and do not display an unacknowledged stage', async t => {
  const f = await fixture(t)
  f.w.mutate = async () => { throw Error('Stage save failed') }
  const stage = f.w.document.querySelector('.writing-scene-margin select')
  await f.app.select(stage, 'revised')
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Stage save failed/)
  assert.equal(stage.value, 'draft')
})

test('a workspace change while pending prose flushes cannot rename a scene in another book', async t => {
  const f = await fixture(t)
  const stop = f.app.pending(f.app.switchWorkspace)
  await f.app.click(f.button('Scene name'))
  await f.app.input(f.w.document.querySelector('.writing-metadata-input'), 'Retained name')
  await f.app.click(f.button('Save'))
  assert.equal(f.mutations.length, 0)
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /structureWorkspaceChanged/)
  stop()
})

for (const label of ['Scene name', 'Rename act']) {
  test(`${label} retains its workspace guard while pending prose saves`, async t => {
    const f = await fixture(t)
    let release
    const stop = f.app.pending(() => new Promise(resolve => { release = resolve }))
    await f.app.click(f.button(label))
    await f.app.input(f.w.document.querySelector('.writing-metadata-input'), 'Protected name')
    await f.app.click(f.button('Save'))
    assert.equal(f.app.guarded(), true)
    assert.equal(f.mutations.length, 0)
    stop()
    f.w.mutate = async () => {
      assert.equal(f.app.guarded(), label !== 'Rename act')
      throw Error('Name save failed')
    }
    release()
    await f.app.click(f.w.document.body)
    assert.equal(f.app.guarded(), true)
    assert.equal(f.w.document.querySelector('.writing-metadata-input').value, 'Protected name')
    assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Name save failed/)
  })
}
