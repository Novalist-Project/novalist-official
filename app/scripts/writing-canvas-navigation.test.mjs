import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({}));`,
  stageStore: `import { create } from 'zustand'; export const useStageStore = create(() => ({ stages: [] }));`,
  shellStore: `export const useShellStore = { getState: () => ({}) };`,
  settingsStore: `import { create } from 'zustand'; export const useSettingsStore = create(() => ({ view: { effective: { pageViewEnabled: false } } }));`,
  useUnifiedWritingDocument: `import { create } from 'zustand';
    import { useProjectStore } from './src/renderer/src/stores/projectStore';
    export const model = create(() => ({}));
    export const useUnifiedWritingDocument = () => ({ ...model(), chapters: useProjectStore(state => state.chapters) });`,
  filterStore: `import { create } from 'zustand';
    export const useFilterStore = create(() => ({ filter: {} })); export const isEmptyFilter = () => true;`,
  manuscriptStore: `export const useManuscriptStore = { setState() {} };`,
  sharedWritingSessions: `export const getSharedWritingSession = () => { throw Error('Unexpected shared owner'); };`,
  useWritingInitialZoom: `export const useWritingInitialZoom = () => {};`,
  commandContext: `export const updateEditorSetting = () => { throw Error('Unexpected settings change'); };`,
  writingStructure: `export const executeWritingStructure = async () => { throw Error('Unexpected structure action'); };`,
  hostBridgeStore: `export const useHostBridgeStore = { getState: () => ({ pushToast: message => { throw Error(message); } }) };`,
  sharedMarkdown: `export const openSharedMarkdown = () => { throw Error('Unexpected shared synopsis'); };`,
  MarkdownEditor: `export const MarkdownEditor = () => { throw Error('Unexpected shared editor'); };`,
  EditorFrame: `export const EditorFrame = () => null;`,
  i18n: `export default { t: key => key };`,
  client: `export const rpc = { request: (...args) => window.request(...args) };`
}
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { createInstance } from 'i18next'
  import { I18nextProvider } from 'react-i18next'
  import { UnifiedWritingEditor } from './src/renderer/src/views/editor/UnifiedWritingEditor'
  import { WritingDocumentRegistry } from './src/renderer/src/stores/writingDocuments'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { model } from './src/renderer/src/views/editor/useUnifiedWritingDocument'
  import { flushPendingWrites } from './src/renderer/src/stores/pendingWrites'
  let root, registry, refs, i18n
  const context = { workspaceId: '/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const subscriptions = new Map(), releases = new Map()
  export async function mount(count) {
    refs = Array.from({ length: count }, (_, index) => ({ bookId: 'book', draftId: 'draft',
      chapterGuid: index < count / 2 ? 'first' : 'second', sceneId: 'scene-' + index }))
    registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
      read: async () => ({ html: '<p>Saved prose.</p>', hash: 'saved' }), activate: async () => true,
      commit: async request => ({ status: 'committed', operationId: request.transactionId,
        hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
    } })
    const subscribe = registry.subscribe.bind(registry)
    registry.subscribe = (ref, listener) => {
      subscriptions.set(ref.sceneId, (subscriptions.get(ref.sceneId) ?? 0) + 1)
      const release = subscribe(ref, listener)
      return () => { releases.set(ref.sceneId, (releases.get(ref.sceneId) ?? 0) + 1); release() }
    }
    const snapshots = await Promise.all(refs.map(ref => registry.read(ref)))
    const chapters = ['first', 'second'].map((guid, order) => ({ guid, title: guid, order,
      scenes: refs.filter(ref => ref.chapterGuid === guid).map(ref => ({ id: ref.sceneId, wordCount: 11, synopsis: '' })) }))
    useProjectStore.setState({ chapters, projectPath: '/project', activeBookId: 'book', activeDraftId: 'draft', workspaceEpoch: 1,
      books: [{ id: 'book', name: 'Test book' }], drafts: [{ id: 'draft', name: 'Draft 1' }] })
    const live = document.getElementById('frame').contentWindow
    live.setPageView = () => {}
    live.document.body.innerHTML = '<div id="editor"></div>'
    for (const ref of refs) {
      const section = live.document.createElement('section'); section.dataset.writingScene = ref.sceneId
      live.document.getElementById('editor').append(section)
    }
    live.getWritingSceneRoot = id => live.document.querySelector('[data-writing-scene="' + id + '"]')
    live.HTMLElement.prototype.showPopover = function () { this.dataset.open = 'true' }
    model.setState({ live, registry, snapshots, refs, scope: 'manuscript', anchor: refs[0],
      projectionRevision: 1, selectedSceneIds: null, selection: { focus: refs[0] },
      loading: false, error: null, adapter: {}, setScope() {} })
    i18n = createInstance(); await i18n.init({ lng: 'en', fallbackLng: 'en', resources: {
      en: { translation: { unifiedWriting: { words: '{{count}} words' }, sceneNotes: { synopsisTitle: 'Synopsis' } } },
      de: { translation: { unifiedWriting: { words: '{{count}} Wörter' }, sceneNotes: { synopsisTitle: 'Zusammenfassung' } } }
    } })
    root = createRoot(document.getElementById('host'))
    await act(async () => root.render(<I18nextProvider i18n={i18n}><UnifiedWritingEditor paneId="pane" /></I18nextProvider>))
  }
  export const counts = () => ({ subscriptions: [...subscriptions.values()].reduce((sum, count) => sum + count, 0),
    releases: [...releases.values()].reduce((sum, count) => sum + count, 0) })
  export async function navigate(index) { await act(async () => model.setState({ anchor: refs[index], selection: { focus: refs[index] } })) }
  export async function editProse(index, afterHtml) { await act(async () => {
    const ref = refs[index], before = registry.getSnapshot(ref)
    registry.apply({ id: crypto.randomUUID(), context, origin: 'writer', kind: 'input',
      changes: [{ ref, beforeHtml: before.html, afterHtml, expectedRevision: before.revision }],
      annotationChanges: [], beforeSelection: null, afterSelection: null })
  }) }
  export async function metadata() { await act(async () => useProjectStore.setState(state => ({
    chapters: state.chapters.map((chapter, index) => index ? chapter : { ...chapter, title: 'Renamed chapter',
      scenes: chapter.scenes.map(scene => scene.id === 'scene-1' ? { ...scene, wordCount: 27 } : scene) })
  }))) }
  export async function language() { await act(async () => i18n.changeLanguage('de')) }
  export async function click(element) { await act(async () => element.click()) }
  export async function synopsis(element, text) { await act(async () => {
    Object.getOwnPropertyDescriptor(element.ownerDocument.defaultView.HTMLTextAreaElement.prototype, 'value').set.call(element, text)
    element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', { bubbles: true }))
  }); await act(async () => flushPendingWrites()) }
  export async function narrow() { await act(async () => {
    const live = model.getState().live; Object.defineProperty(live, 'innerWidth', { value: 400, configurable: true })
    live.dispatchEvent(new live.Event('resize'))
  }) }
  export async function unmount() { if (root) { await act(async () => root.unmount()); root = null; await registry.close() } }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'canvasFixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'text' },
  plugins: [{ name: 'canvas-host', setup(builder) {
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }] })

async function fixture(t, count = 4) {
  const dom = new JSDOM('<div id="host"></div><iframe id="frame"></iframe>', {
    url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true
  })
  const w = dom.window, channels = [], saved = new Map()
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.structuredClone = structuredClone
  w.CSSStyleDeclaration.prototype[Symbol.iterator] = function* () { for (let index = 0; index < this.length; index++) yield this[index] }
  for (const [key, value] of Object.entries({ 'min-prose': 320, 'margin-expanded': 176, gap: 12 }))
    w.document.documentElement.style.setProperty('--nl-writing-' + key, value + 'px')
  w.request = async (method, args) => {
    if (method === 'scenes/getMeta') return { synopsis: saved.get(args[1]) ?? '' }
    if (method === 'scenes/setSynopsis') { saved.set(args[1], args[2]); return }
    throw Error('Unexpected RPC: ' + method)
  }
  t.after(async () => { await w.canvasFixture?.unmount(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  w.eval(bundle.outputFiles[0].text)
  const app = w.canvasFixture
  await app.mount(count)
  const canvas = w.document.getElementById('frame').contentDocument
  return { w, app, canvas, saved, margins: () => [...canvas.querySelectorAll('.writing-scene-margin')] }
}

test('scene navigation retains every unrelated scene margin subscription and DOM', async t => {
  const f = await fixture(t, 200)
  const before = f.app.counts(), margins = f.margins()
  const computedStyle = f.w.getComputedStyle
  let directionChecks = 0
  f.w.getComputedStyle = (element, ...args) => {
    if (element.tagName === 'BDI') directionChecks++
    return computedStyle(element, ...args)
  }
  for (const index of [1, 100, 199, 0, 50]) await f.app.navigate(index)
  assert.equal(directionChecks, 0, 'caret movement must not recompute unchanged scene control directions')
  assert.deepEqual(f.app.counts(), before, 'navigation must not replace subscriptions for retained scene chrome')
  assert.deepEqual(f.margins(), margins)
  assert.equal(f.canvas.querySelector('.writing-book-heading h1').textContent, 'Test book')
  assert.equal(f.canvas.querySelector('[data-writing-scene="scene-50"]').dataset.writingActive, 'true')
})

test('retained chrome still follows live prose, metadata, locale, synopsis edits and narrow layout', async t => {
  const f = await fixture(t)
  const margins = f.margins()
  await f.app.editProse(0, '<p>One two three.</p>')
  assert.equal(margins[0].querySelector('small').textContent, '3 words')
  assert.equal(margins[1].querySelector('small').textContent, '11 words')
  await f.app.metadata()
  assert.equal(f.canvas.querySelector('h2').textContent, 'Renamed chapter')
  assert.equal(margins[1].querySelector('small').textContent, '27 words')
  assert.deepEqual(f.margins(), margins, 'metadata must preserve mounted scene chrome')
  await f.app.language()
  assert.equal(margins[0].querySelector('small').textContent, '3 Wörter')
  await f.app.click(margins[1].querySelector('button[aria-expanded]'))
  await f.app.synopsis(margins[1].querySelector('textarea'), 'Unsaved plans become saved plans')
  assert.equal(f.saved.get('scene-1'), 'Unsaved plans become saved plans')
  await f.app.navigate(3)
  assert.equal(margins[1].querySelector('textarea').value, 'Unsaved plans become saved plans')
  await f.app.narrow()
  assert.equal(margins[1].querySelector('.writing-synopsis-popover textarea').value, 'Unsaved plans become saved plans')
  await f.app.click(f.w.document.querySelector('.writing-toolbar-icon'))
  assert.equal(margins[1].querySelector('textarea'), null)
  assert.equal(margins[1].querySelector('button[aria-expanded]'), null)
  await f.app.click(f.w.document.querySelector('.writing-toolbar-icon'))
  assert.equal(margins[1].querySelector('textarea').value, 'Unsaved plans become saved plans')
})
