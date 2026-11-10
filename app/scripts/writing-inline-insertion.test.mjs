import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({}));`,
  stageStore: `export const useStageStore = select => select({ stages: [] });`,
  shellStore: `export const useShellStore = { getState: () => ({ activePaneId: 'other-pane' }) };`,
  useWritingCanvas: `export const useWritingChromeTargets = () => window.targets;`,
  writingStructure: `import { create } from 'zustand';
    export const useWritingStructureStatus = create(() => ({ error: null, pending: null, busy: false }));
    export const executeWritingStructure = (command, selection) => window.execute(command, selection);
    export const retryWritingStructure = async () => {};`,
  writingNavigation: `export const getWritingNavigation = pane => ({ capture: () => window.events.push(['capture', pane]) });`,
  editorBridge: `export const editorWindow = () => window.editor;`,
  InputDialog: `export const InputDialog = ({ title, onSubmit }) => <div role="dialog">{title}<button onClick={() => onSubmit('New chapter')}>Create chapter</button></div>;`,
  WritingSceneMargin: `export const WritingSceneMargin = () => null;`,
  WritingMetadataName: `export const WritingMetadataName = ({ value }) => <span>{value}</span>;`,
  hostBridgeStore: `export const useHostBridgeStore = { getState: () => ({ pushToast: message => window.events.push(['toast', message]) }) };`,
  writingError: `export const writingErrorMessage = reason => String(reason);`,
  'react-i18next': `export const useTranslation = () => ({ t: (key, args) => key === 'writing.sceneName' ? 'Scene ' + args.number : key });`
}
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { WritingCanvasChrome } from './src/renderer/src/views/editor/WritingCanvasChrome'
  import { WritingStructureHost } from './src/renderer/src/views/editor/WritingStructureHost'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  let root
  export async function mount(options) {
    const chapters = options.chapters
    const context = { workspaceId: '/project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
    const ref = (chapterGuid, sceneId) => ({ bookId: 'book', draftId: 'draft', chapterGuid, sceneId })
    const snapshots = options.visible.map(([chapter, scene]) => ({ ...ref(chapter, scene), html: '<p>' + scene + '</p>', hash: scene + '-hash' }))
    const registry = { context, getSnapshot: target => snapshots.find(scene => scene.sceneId === target.sceneId),
      read: async target => { window.events.push(['read', target.sceneId]); return { ...target, html: '<p>Canonical unseen prose</p>', hash: 'unseen-hash' } } }
    useProjectStore.setState({ projectPath: '/project', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft', chapters,
      getWritingRegistry: () => registry, openChapterGuid: 'created-chapter', openSceneId: 'created-scene',
      openSceneIn: (...args) => window.events.push(['open', ...args]) })
    window.execute = async (command, selection) => {
      window.events.push(['execute', command, selection])
      if (window.rejectWrite) throw Error('Pending prose failed')
    }
    window.editor = { getWritingSceneRoot: sceneId => snapshots.some(scene => scene.sceneId === sceneId), captureWritingSplit: point => {
      window.events.push(['split', point]); return { sourceHtml: '<p>Live prose</p>', beforeHtml: '<p><br></p>', afterHtml: '<p>Live prose</p>' }
    } }
    const target = id => { const node = document.createElement('div'); node.id = id; document.body.append(node); return node }
    window.targets = { targets: snapshots.map(scene => ({ scene, element: target(scene.sceneId) })),
      emptyTargets: chapters.filter(chapter => !chapter.scenes.length).map(chapter => ({ chapter, element: target(chapter.guid) })),
      endTarget: target('end'), introTarget: null }
    const onStructure = request => {
      window.events.push(['request', request]); window.dispatchEvent(new CustomEvent('novalist:writing-structure', { detail: { ...request, paneId: 'pane-2' } }))
    }
    root = createRoot(document.getElementById('host'))
    await act(async () => root.render(<><WritingStructureHost /><WritingCanvasChrome live={null} registry={registry} snapshots={snapshots}
      chapters={chapters} scope={options.scope ?? 'manuscript'} limited={options.limited ?? false} revision={1} narrow={false}
      showSynopsis={false} bookTitle="Book" draftName="Draft" onFocusScene={() => {}} onStructure={onStructure} /></>))
  }
  export async function click(element) { await act(async () => element.click()) }
  export async function unmount() { await act(async () => root.unmount()) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'insertionFixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'insertion-host', setup(builder) {
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory, loader: 'tsx' }))
  } }] })

const chapter = (guid, order, ids, act = 'Act one') => ({ guid, order, act, title: guid, scenes: ids.map(id => ({ id, title: id })) })
const chapters = [chapter('a', 1, ['a1', 'a2', 'a3']), chapter('b', 2, ['b1'], 'Act two')]

async function fixture(t, options = {}) {
  const dom = new JSDOM('<div id="host"></div><div data-writing-pane="pane-2"><iframe></iframe></div>', { url: 'http://localhost', runScripts: 'outside-only' })
  const w = dom.window, channels = []
  w.CSS = { escape: value => value }
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.events = []
  w.eval(bundle.outputFiles[0].text)
  const app = w.insertionFixture
  await app.mount({ chapters, visible: [['a', 'a1'], ['a', 'a2'], ['a', 'a3'], ['b', 'b1']], ...options })
  t.after(async () => { await app.unmount(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  const button = (target, kind) => w.document.querySelector('#' + target + ' [data-writing-insert="' + kind + '"]')
  const plainEvents = () => JSON.parse(JSON.stringify(w.events))
  return { w, app, button, plainEvents }
}

test('between-scene action inserts a fresh scene without offering an identity-changing chapter split', async t => {
  const f = await fixture(t)
  assert.ok(f.button('a2', 'scene'), 'Scene boundary action exists')
  assert.equal(f.button('a2', 'chapter'), null)
  await f.app.click(f.button('a2', 'scene'))
  assert.deepEqual(f.plainEvents().find(event => event[0] === 'execute')[1], { kind: 'insertScene', chapterGuid: 'a', beforeSceneId: 'a2', title: 'Scene 4' })
  assert.deepEqual(f.plainEvents().filter(event => event[0] === 'capture' || event[0] === 'open'), [['capture', 'pane-2'], ['open', 'pane-2', 'created-chapter', 'created-scene']])
})

test('chapter boundaries append scenes to the preceding chapter and inherit its act for a new chapter', async t => {
  const f = await fixture(t)
  assert.ok(f.button('b1', 'scene'))
  await f.app.click(f.button('b1', 'scene'))
  assert.deepEqual(f.plainEvents().find(event => event[0] === 'execute')[1], { kind: 'insertScene', chapterGuid: 'a', beforeSceneId: null, title: 'Scene 4' })
  f.w.events = []
  await f.app.click(f.button('b1', 'chapter'))
  await f.app.click([...f.w.document.querySelectorAll('button')].find(button => button.textContent === 'Create chapter'))
  assert.deepEqual(f.plainEvents().find(event => event[0] === 'execute')[1], { kind: 'insertChapter', title: 'New chapter', beforeChapterGuid: 'b', actName: 'Act one' })
})

test('end of scene scope inserts after that scene and offers no chapter split in the middle of a chapter', async t => {
  const f = await fixture(t, { scope: 'scene', visible: [['a', 'a1']] })
  assert.ok(f.button('end', 'scene'))
  await f.app.click(f.button('end', 'scene'))
  assert.equal(f.plainEvents().find(event => event[0] === 'execute')[1].beforeSceneId, 'a2')
  assert.equal(f.button('end', 'chapter'), null)
  assert.equal(f.plainEvents().some(event => event[0] === 'read' || event[0] === 'split'), false)
})

test('filtered gaps have no ambiguous insertion controls; empty chapters use the host route', async t => {
  const f = await fixture(t, { limited: true, visible: [['a', 'a1'], ['a', 'a3']] })
  assert.equal(f.button('a3', 'scene'), null)
  assert.equal(f.button('a3', 'chapter'), null)
  assert.equal(f.button('end', 'scene'), null)
})

test('empty chapter and manuscript end scene actions capture before commit and surface write rejection', async t => {
  const f = await fixture(t, { chapters: [chapter('empty', 1, [])], visible: [] })
  assert.ok(f.button('empty', 'scene'))
  f.w.rejectWrite = true
  await f.app.click(f.button('empty', 'scene'))
  assert.deepEqual(f.plainEvents().filter(event => event[0] === 'capture'), [['capture', 'pane-2']])
  assert.equal(f.plainEvents().some(event => event[0] === 'open'), false)
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Pending prose failed/)
})

test('end of a chapter scope inserts its next chapter before the existing following chapter', async t => {
  const f = await fixture(t, { scope: 'chapter', visible: [['a', 'a1'], ['a', 'a2'], ['a', 'a3']] })
  assert.ok(f.button('end', 'chapter'))
  await f.app.click(f.button('end', 'chapter'))
  await f.app.click([...f.w.document.querySelectorAll('button')].find(button => button.textContent === 'Create chapter'))
  assert.deepEqual(f.plainEvents().find(event => event[0] === 'execute')[1], { kind: 'insertChapter', title: 'New chapter', beforeChapterGuid: 'b', actName: 'Act one' })
})

test('an empty manuscript still offers its first chapter without an invalid scene destination', async t => {
  const f = await fixture(t, { chapters: [], visible: [] })
  assert.equal(f.button('end', 'scene'), null)
  assert.ok(f.button('end', 'chapter'))
  await f.app.click(f.button('end', 'chapter'))
  await f.app.click([...f.w.document.querySelectorAll('button')].find(button => button.textContent === 'Create chapter'))
  assert.deepEqual(f.plainEvents().find(event => event[0] === 'execute')[1], { kind: 'insertChapter', title: 'New chapter', beforeChapterGuid: null, actName: null })
})
