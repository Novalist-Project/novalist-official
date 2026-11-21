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
  import { ChapterDialog } from './src/renderer/src/shell/ChapterDialog'
  import { hasWorkspaceDialogDraft } from './src/renderer/src/shell/useWorkspaceDialogGuard'
  let root
  export async function render() { await act(async () => {
    root = createRoot(document.getElementById('host'))
    root.render(<ChapterDialog onClose={() => window.closedDialog = true} />)
  }) }
  export const guarded = hasWorkspaceDialogDraft
  export async function submit() { await act(async () => {
    const input = document.querySelector('input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'New chapter')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }); await act(async () => document.querySelector('.dialog-button.primary').click()) }
  export async function settle(callback) { await act(callback) }
  export async function close() { await act(async () => root.unmount()) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'fixture', jsx: 'automatic', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'chapter-dependencies', setup(builder) {
    const sources = {
      MotionPresence: 'export const useMotionPresent = () => true',
      useDialogKeyboard: 'export const useDialogAutoFocus = () => {}',
      'react-i18next': 'export const useTranslation = () => ({ t: key => key })',
      client: 'export const rpc = { request: async () => [] }',
      projectStore: 'const state = { chapters: [], applyState() {} }; export const useProjectStore = { getState: () => state }',
      manuscriptPropsStore: 'export const useManuscriptPropsStore = selector => selector({ definitions: [] }); useManuscriptPropsStore.getState = () => ({ load() {} })',
      ManuscriptPropertyField: 'export const ManuscriptPropertyField = () => null',
      ChapterActField: 'export const ChapterActField = () => null',
      projectSceneActions: 'export const prepareChapterInsertion = (...args) => window.prepare(...args); export const prepareChapterAct = prepareChapterInsertion',
      writingStructure: 'export const executeWritingStructure = command => window.execute(command)',
      writingError: 'export const writingErrorMessage = text => text'
    }
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }] })

test('ChapterDialog retains its draft during command preparation and restores it after failed execution', async t => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost', runScripts: 'outside-only' })
  const w = dom.window, channels = []
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.novalist = { isMobile: false }
  let resolve, calls = 0
  w.prepare = () => new Promise(done => { resolve = done })
  w.execute = async () => { calls++; assert.equal(w.fixture.guarded(), false); throw new Error('Structure failed') }
  w.eval(bundle.outputFiles[0].text)
  t.after(async () => { await w.fixture.close(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  await w.fixture.render()
  await w.fixture.submit()
  assert.equal(w.fixture.guarded(), true)
  assert.equal(calls, 0)
  await w.fixture.settle(async () => resolve({ kind: 'insertChapter' }))
  assert.equal(calls, 1)
  assert.equal(w.fixture.guarded(), true)
  assert.match(w.document.querySelector('[role="alert"]').textContent, /Structure failed/)
  assert.equal(w.closedDialog, undefined)
})
