import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { JSDOM } from 'jsdom'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({ stdin: { resolveDir: directory, loader: 'tsx', contents: `
  import React, { act } from 'react'
  import { createRoot } from 'react-dom/client'
  import { useEditorControls } from './src/renderer/src/views/editor/useEditorSynchronization'
  let root
  const editorRef = { current: { setSuggestionMode() {}, focusEditor() { window.focusCalls++ } } }
  const iframeRef = { current: null }
  function Controls() {
    iframeRef.current = document.getElementById('target')
    useEditorControls({ editorRef, iframeRef, isActiveEditor: true, openSceneId: 'scene', pane: 'target',
      suggestionMode: false, reviewerName: '', sceneHtml: '', setLinkPrompt() {}, toggleReadAloud() {}, speaking: false })
    return null
  }
  export async function mount() { await act(async () => {
    root = createRoot(document.getElementById('host')); root.render(<Controls />)
  }) }
  export async function close() { await act(async () => root.unmount()) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'fixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'control-dependencies', setup(builder) {
    const sources = {
      editorBridgeStore: 'const state = { register() {}, setFrameCommands() {} }; export const useEditorBridge = { getState: () => state }',
      projectStore: 'export const useProjectStore = {}; export const editorPane = () => {}',
      shellStore: 'export const useShellStore = {}',
      pendingWrites: 'export const registerPendingWrite = () => {}',
      sharedEditors: 'export const captureSharedEditor = () => {}; export const syncSharedEditor = () => {}'
    }
    builder.onResolve({ filter: /./ }, args => {
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path] }))
  } }] })

async function fixture(t) {
  const dom = new JSDOM('<div id="host"></div><iframe id="target"></iframe><iframe id="peer" title="editor"></iframe><button id="binder">Scene</button><input id="note">',
    { url: 'http://localhost', runScripts: 'outside-only' })
  const w = dom.window, channels = [], timers = new Map()
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.novalist = { onSpellingContext() {} }
  w.focusCalls = 0
  w.setTimeout = (callback, delay) => { assert.equal(delay, 60); const id = timers.size + 1; timers.set(id, callback); return id }
  w.clearTimeout = id => timers.delete(id)
  w.eval(bundle.outputFiles[0].text)
  await w.fixture.mount()
  let mounted = true
  const close = async () => { if (mounted) { mounted = false; await w.fixture.close() } }
  t.after(async () => { await close(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  return { w, close, run: () => { for (const callback of [...timers.values()]) callback() } }
}

for (const target of ['peer', 'note', 'binder', 'target']) test(`delayed scene focus respects a newer ${target} focus`, async t => {
  const { w, run } = await fixture(t)
  w.document.getElementById('target').focus()
  w.document.getElementById(target).focus()
  run()
  assert.equal(w.document.activeElement.id, target === 'binder' ? 'target' : target)
  assert.equal(w.focusCalls, target === 'binder' || target === 'target' ? 1 : 0)
})

test('unmount cancels the pending scene focus callback', async t => {
  const { w, close, run } = await fixture(t)
  w.document.getElementById('binder').focus()
  await close()
  run()
  assert.equal(w.document.activeElement.id, 'binder')
  assert.equal(w.focusCalls, 0)
})

test('a focused peer document wins when the host active iframe is stale', async t => {
  const { w, run } = await fixture(t)
  const target = w.document.getElementById('target')
  const peer = w.document.getElementById('peer')
  target.focus()
  target.contentDocument.hasFocus = () => false
  peer.contentDocument.hasFocus = () => true
  assert.equal(w.document.activeElement, target)
  run()
  assert.equal(w.focusCalls, 0)
})
