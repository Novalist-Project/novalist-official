import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

test('editor initialization and live settings updates honor the saved page presentation', () => {
  const calls = []
  const effective = { pageViewEnabled: true }
  const editor = new Proxy({}, { get: (_, method) => (...args) => calls.push([method, ...args]) })
  const { pushEditorSettings } = loadRendererSource('src/views/editor/editorConfiguration.ts', {
    '../../i18n': { default: { language: 'en', dir: () => 'ltr' } },
    './editorBridge': {}, './writingTypography': { pushWritingTypography() {} },
    '../../stores/settingsStore': { useSettingsStore: { getState: () => ({ view: {
      global: { spellCheckCustomWords: [] }, effective
    } }) } },
    '../../rpc/client': { rpc: { request: async () => ({ words: [] }) } }
  }, { window: { novalist: { isMobile: false } } })
  pushEditorSettings(editor, true)
  assert.deepEqual(calls.filter(call => call[0] === 'setPageView'), [['setPageView', true]], 'saved paper presentation applies on first paint')
  calls.length = 0
  effective.pageViewEnabled = false
  pushEditorSettings(editor, false)
  assert.deepEqual(calls.filter(call => call[0] === 'setPageView'), [['setPageView', false]], 'disabling pages applies immediately')
  calls.length = 0
  pushEditorSettings(editor, true)
  assert.deepEqual(calls.filter(call => call[0] === 'setPageView'), [], 'disabled initial presentation needs no repagination')
  calls.length = 0
  effective.pageViewEnabled = true
  pushEditorSettings(editor, false)
  assert.deepEqual(calls.filter(call => call[0] === 'setPageView'), [['setPageView', true]], 'enabling pages uses the same setting')
})
