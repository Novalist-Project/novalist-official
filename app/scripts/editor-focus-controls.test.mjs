import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { loadRendererSource } from './renderer-source-loader.mjs'

function fixture(t) {
  const dom = new JSDOM('<button id="scene">Scene</button><iframe></iframe><div class="focus-bar"><button>Writing tools</button></div><div class="editor-toolbar"><button>Bold</button></div><textarea></textarea>')
  t.after(() => dom.window.close())
  const { document, HTMLElement, HTMLIFrameElement } = dom.window
  const iframe = document.querySelector('iframe')
  const editor = iframe.contentDocument.createElement('textarea')
  iframe.contentDocument.body.append(editor)
  document.querySelector('#scene').focus()
  const timers = new Map()
  const cleanups = []
  const changes = []
  const shell = { focusMode: true, focusToolsVisible: false,
    setFocusToolsVisible(visible) { shell.focusToolsVisible = visible } }
  const live = { focusEditor: () => editor.focus(), setSuggestionMode() {} }
  const bridge = { register() {}, setFrameCommands() {} }
  const dependencies = {
    react: { useEffect: effect => cleanups.push(effect()) },
    '../../stores/editorBridgeStore': { useEditorBridge: { getState: () => bridge } },
    '../../stores/projectStore': { useProjectStore: { getState: () => ({
      onEditorContentChanged: (...args) => changes.push(args)
    }) } },
    '../../stores/shellStore': { useShellStore: { getState: () => shell } },
    '../../stores/pendingWrites': {},
    '../../collaboration/sharedEditors': { captureSharedEditor: () => false }
  }
  const globals = { document, HTMLElement, HTMLIFrameElement, window: {
    novalist: { onSpellingContext() {} },
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id)
  } }
  const model = { pane: 'pane', openSceneId: 'scene', isActiveEditor: true,
    iframeRef: { current: iframe }, editorRef: { current: live },
    loadingRef: { current: false }, lastReportedHtmlRef: { current: '' }, iframe }
  const { useEditorControls } = loadRendererSource('src/views/editor/useEditorSynchronization.ts', dependencies, globals)
  useEditorControls(model)
  t.after(() => { for (const cleanup of cleanups) cleanup?.() })
  const { createEditorContentMessages } = loadRendererSource('src/views/editor/editorContentMessages.ts', dependencies, globals)
  const handlers = createEditorContentMessages(model)
  return { document, iframe, editor, shell, changes,
    autofocus() {
      assert.equal(timers.size, 1)
      for (const { callback, delay } of timers.values()) { assert.equal(delay, 60); callback() }
      timers.clear()
    },
    report() { handlers.contentChanged({ html: '<p>Back again.</p>', plainText: 'Back again.' }) }
  }
}

for (const selector of ['.focus-bar button', '.editor-toolbar button', 'textarea']) {
  test(`delayed scene autofocus preserves a newly focused ${selector}`, t => {
    const f = fixture(t)
    f.editor.focus()
    const control = f.document.querySelector(selector)
    control.focus()
    f.shell.focusToolsVisible = true
    f.autofocus()
    f.report()
    assert.equal(f.document.activeElement, control)
    assert.equal(f.shell.focusToolsVisible, true, 'pending content must not hide the tools')
    assert.deepEqual(f.changes, [['pane', '<p>Back again.</p>', 'Back again.']])
  })
}

test('opening a scene still focuses its prose and typing hides focus tools', t => {
  const f = fixture(t)
  f.autofocus()
  assert.equal(f.document.activeElement, f.iframe)
  assert.equal(f.iframe.contentDocument.activeElement, f.editor)
  f.shell.focusToolsVisible = true
  f.report()
  assert.equal(f.shell.focusToolsVisible, false)
  assert.equal(f.changes.length, 1)
})
