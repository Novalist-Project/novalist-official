import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

function fixture(mobile = false) {
  const languages = [], dialogue = []
  const editor = new Proxy({}, { get: (_, method) => (...args) => {
    if (method === 'setLanguage') languages.push(args[0])
    if (method === 'setDialogueCorrectionConfig') dialogue.push(JSON.parse(args[0]))
  } })
  const settings = { view: { global: { spellCheckCustomWords: [] }, effective: {
    language: 'en', autoReplacementLanguage: 'en', grammarCheckLanguage: 'de-CH', spellCheckLanguages: ['de-CH'],
    grammarCheckEnabled: true, spellCheckEnabled: true, dialogueCorrectionEnabled: true
  } }, load: async () => {}, subscribe: () => () => {} }
  const stores = { useSettingsStore: Object.assign(() => {}, { getState: () => settings, subscribe: settings.subscribe }) }
  const globals = { window: { novalist: { isMobile: mobile } }, document: { documentElement: {} },
    MutationObserver: class { observe() {} disconnect() {} } }
  const configuration = loadRendererSource('src/views/editor/editorConfiguration.ts', {
    './editorBridge': { inlineActionDescriptorsJson: () => '[]', extensionContextMenuItemsJson: () => '[]' },
    './writingTypography': { pushWritingTypography() {} }, '../../stores/settingsStore': stores,
    '../../rpc/client': { rpc: { request: async () => ({ words: [] }) } }
  }, globals)
  const shell = { getState: () => ({ mainView: 'write', activePaneId: 'pane-1' }), subscribe: () => () => {} }
  const context = { pane: 'pane-1', iframe: {}, iframeRef: { current: {} }, editorRef: { current: null },
    i18n: { language: 'en' }, t: key => key, writing: { ready() {} },
    loadingRef: { current: false }, lastReportedHtmlRef: { current: '' },
    loadAnnotations: async () => false, applyFootnoteOrder() {}, pushEntityNames: async () => {},
    peekRef: { current: { clearHide() {} } } }
  const common = {
    './editorBridge': { editorWindow: () => editor, pushEditorTheme() {}, listenToEditor: () => () => {} },
    './editorConfiguration': configuration, '../../stores/settingsStore': stores,
    '../../stores/writingZoomStore': { useWritingZoomStore: { getState: () => ({ initialized: true }), subscribe: () => () => {} } },
    '../../stores/shellStore': { useShellStore: shell },
    '../../collaboration/sharedEditors': { syncSharedEditor() {}, detachSharedEditor() {} }
  }
  const ready = loadRendererSource('src/views/editor/editorReadyMessages.ts', { ...common,
    '../../stores/editorBridgeStore': { useEditorBridge: { getState: () => ({ register() {} }) } },
    '../../stores/projectStore': { useProjectStore: { getState: () => ({ activeEditorPaneId: 'pane-1' }) },
      editorPane: () => ({ sceneId: 'scene-1', html: '<p>Synthetic prose</p>' }) },
    '../../rpc/client': { rpc: { request: async () => 'gallery/' } }
  }, globals)
  let cleanup
  const messages = loadRendererSource('src/views/editor/useEditorMessages.ts', { ...common,
    react: { useEffect: callback => { cleanup = callback() } },
    './editorMessageHandlers': { createEditorMessageHandlers: () => new Map() }
  }, globals)
  return { editor, settings, context, configuration, languages, dialogue,
    ready: () => ready.createEditorReadyMessages(context).ready(),
    reconnect: () => { messages.useEditorMessages(context); cleanup() } }
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} settings apply the resolved proofing language while preserving the quote preset`, () => {
    const f = fixture(mobile)
    f.configuration.pushEditorSettings(f.editor)
    f.configuration.pushEditorConfig(f.editor, key => key)
    assert.deepEqual(f.languages, ['de-CH'])
    assert.equal(f.dialogue[0].ruleFamily, 'en')
    assert.equal(f.dialogue[0].openQuote, '“')
    f.settings.view.effective.grammarCheckLanguage = 'fr'
    f.configuration.pushEditorSettings(f.editor)
    assert.deepEqual(f.languages, ['de-CH', 'fr'])
  })
}

test('ready initializes proofing from writing settings without pushing the English UI language', () => {
  const f = fixture()
  f.ready()
  assert.deepEqual(f.languages, ['de-CH'])
})

test('ready waits for loaded writing settings before choosing a proofing language', async () => {
  const f = fixture()
  const view = f.settings.view
  f.settings.view = null
  let completeLoad
  f.settings.load = () => new Promise(resolve => { completeLoad = resolve })
  f.ready()
  assert.deepEqual(f.languages, [])
  f.settings.view = view
  completeLoad()
  await Promise.resolve()
  assert.deepEqual(f.languages, ['de-CH'])
})

test('reacquiring an editor after a UI-language change retains the resolved writing language', () => {
  const f = fixture()
  f.reconnect()
  assert.deepEqual(f.languages, ['de-CH'])
  f.context.i18n.language = 'zh-CN'
  f.settings.view.effective.grammarCheckLanguage = 'en-GB'
  f.reconnect()
  assert.deepEqual(f.languages, ['de-CH', 'en-GB'])
})
