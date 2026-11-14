import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { UnifiedWritingEditor } from './src/renderer/src/views/editor/UnifiedWritingEditor'
  import { editorSettingsBody } from './src/renderer/src/views/settings/editorSettingsBody'
  import { useSettingsStore } from './src/renderer/src/stores/settingsStore'
  let root
  function Fixture() {
    const view = useSettingsStore(state => state.view), eff = view.effective
    const context = { eff, t: key => key, scopeToggle: () => null, fontDatalist: null,
      systemVoices: [], voices: [], isMobile: window.novalist.isMobile,
      scopeFor: () => view.hasProject && view.overriddenSections?.editor ? 'project' : 'global',
      update: useSettingsStore.getState().update }
    return <>{editorSettingsBody(context)}{!window.novalist.isMobile && <>
      <UnifiedWritingEditor paneId="one" /><UnifiedWritingEditor paneId="two" /></>}</>
  }
  export async function mount(options) {
    useSettingsStore.setState({ view: { hasProject: options.hasProject,
      overriddenSections: options.hasProject ? { editor: options.overridden } : null,
      effective: { pageViewEnabled: options.enabled } } })
    root = createRoot(document.getElementById('host')); await act(async () => root.render(<Fixture />))
  }
  export async function receiveSettings(enabled) { await act(async () => useSettingsStore.setState(state => ({
    view: { ...state.view, effective: { ...state.view.effective, pageViewEnabled: enabled } }
  }))) }
  export async function click(element) { await act(async () => element.click()) }
  export async function close() { await act(async () => root.unmount()) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'pageFixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'text' },
  plugins: [{ name: 'page-settings-host', setup(builder) {
    const sources = {
      'react-i18next': `export const useTranslation = () => ({ t: key => key });`,
      'react-markdown': `export default () => null;`,
      i18n: `export default { t: key => key };`,
      SettingsInputs: `export const SettingInput = () => null; export const SettingNumber = () => null;`,
      EditorFrame: `export const EditorFrame = () => null;`,
      WritingCanvasChrome: `export const WritingCanvasChrome = () => null;`,
      useUnifiedWritingDocument: `export const useUnifiedWritingDocument = pane => window.models[pane];`,
      useWritingCanvas: `export const useWritingCanvasStyles = () => false;`,
      useWritingInitialZoom: `export const useWritingInitialZoom = () => {};`,
      projectStore: `export const useProjectStore = select => select({ books: [], drafts: [] });`,
      settingsStore: `import { create } from 'zustand'; export const useSettingsStore = create((set, get) => ({ view: null,
        update: async (scope, values) => {
          window.updates.push({ scope, values }); set(state => ({ view: { ...state.view, effective: { ...state.view.effective, ...values } } }))
        } }));`,
      editorBridgeStore: `export const useEditorBridge = {};`,
      filterStore: `export const useFilterStore = select => select({ filter: {} }); export const isEmptyFilter = () => true;`,
      manuscriptStore: `export const useManuscriptStore = {};`,
      shellStore: `export const useShellStore = {};`
    }
    builder.onResolve({ filter: /./ }, args => {
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }]
})

async function fixture(t, { saved, mobile = false, enabled = true, overridden = true, hasProject = true } = {}) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'https://fixture.invalid/', runScripts: 'outside-only' })
  const w = dom.window, channels = [], pages = { one: [], two: [] }
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.novalist = { isMobile: mobile }; w.updates = []
  if (saved !== undefined) w.localStorage.setItem('nl.writing.pageView', saved)
  w.models = Object.fromEntries(Object.keys(pages).map(pane => [pane, {
    live: { setPageView: enabled => pages[pane].push(enabled) }, registry: null, snapshots: [], chapters: [], refs: [{}],
    adapter: {}, scope: 'manuscript', selectedSceneIds: null, projectionRevision: 1, selection: null,
    loading: false, error: null, setScope() {}
  }]))
  w.eval(bundle.outputFiles[0].text)
  const app = w.pageFixture
  t.after(async () => { await app.close(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  await app.mount({ enabled, overridden, hasProject })
  return { app, w, pages, setting: () => w.document.getElementById('set-page-view'),
    buttons: () => [...w.document.querySelectorAll('button[aria-label="blockStyle.pageView"]')] }
}

test('desktop Page View inherits the actual project setting and Settings updates both mounted writers', async t => {
  const f = await fixture(t)
  assert.equal(f.setting().checked, true)
  assert.deepEqual(f.pages, { one: [true], two: [true] })
  await f.app.click(f.setting())
  assert.equal(f.setting().checked, false)
  assert.deepEqual(f.pages, { one: [true, false], two: [true, false] })
  assert.equal(f.w.localStorage.getItem('nl.writing.pageView'), null)
  assert.deepEqual(JSON.parse(JSON.stringify(f.w.updates)), [{ scope: 'project', values: { pageViewEnabled: false } }])
})

for (const enabled of [true, false]) {
  test(`stale writer preference cannot mask effective Page View ${enabled}; toolbar persists the project override`, async t => {
    const saved = String(!enabled)
    const f = await fixture(t, { saved, enabled })
    assert.equal(f.setting().checked, enabled)
    assert.deepEqual(f.pages, { one: [enabled], two: [enabled] })
    await f.app.click(f.buttons()[0])
    assert.equal(f.setting().checked, !enabled)
    assert.deepEqual(f.pages, { one: [enabled, !enabled], two: [enabled, !enabled] })
    assert.equal(f.buttons()[1].getAttribute('aria-pressed'), String(!enabled))
    assert.equal(f.w.localStorage.getItem('nl.writing.pageView'), saved)
    assert.deepEqual(JSON.parse(JSON.stringify(f.w.updates)), [{ scope: 'project', values: { pageViewEnabled: !enabled } }])
  })
}

for (const hasProject of [true, false]) {
  test(`toolbar writes global Page View when ${hasProject ? 'the project inherits editor settings' : 'no project is open'}`, async t => {
    const f = await fixture(t, { enabled: false, overridden: false, hasProject })
    await f.app.click(f.buttons()[0])
    assert.deepEqual(JSON.parse(JSON.stringify(f.w.updates)), [{ scope: 'global', values: { pageViewEnabled: true } }])
    assert.deepEqual(f.pages, { one: [false, true], two: [false, true] })
    assert.equal(f.setting().checked, true)
  })
}

test('new effective project settings update both mounted writers without a local preference override', async t => {
  const f = await fixture(t, { saved: 'false' })
  await f.app.receiveSettings(false)
  await f.app.receiveSettings(true)
  assert.deepEqual(f.pages, { one: [true, false, true], two: [true, false, true] })
  assert.equal(f.setting().checked, true)
  assert.equal(f.w.updates.length, 0)
})

test('mobile Page View keeps the effective setting without changing the desktop preference', async t => {
  const f = await fixture(t, { saved: 'true', mobile: true })
  await f.app.click(f.setting())
  assert.equal(f.setting().checked, false)
  assert.equal(f.w.localStorage.getItem('nl.writing.pageView'), 'true')
  assert.deepEqual(JSON.parse(JSON.stringify(f.w.updates)), [{ scope: 'project', values: { pageViewEnabled: false } }])
})
