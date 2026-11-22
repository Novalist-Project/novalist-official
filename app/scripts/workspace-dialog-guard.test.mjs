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
  import { useWorkspaceDialogGuard, hasWorkspaceDialogDraft } from './src/renderer/src/shell/useWorkspaceDialogGuard'
  let root, operations = {}
  function Dialog({ id }) { operations[id] = useWorkspaceDialogGuard(); return null }
  export async function render(ids) { await act(async () => {
    root ||= createRoot(document.getElementById('host'))
    root.render(ids.map(id => <Dialog key={id} id={id} />))
  }) }
  export const guarded = hasWorkspaceDialogDraft
  export const run = (id, operation) => operations[id](operation)
  export async function close() { await act(async () => root.unmount()) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'fixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'motion', setup(builder) {
    builder.onResolve({ filter: /MotionPresence$/ }, () => ({ path: 'motion', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useMotionPresent = () => true' }))
  } }] })

async function fixture(t) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost', runScripts: 'outside-only' })
  const channels = []
  dom.window.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  dom.window.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.eval(bundle.outputFiles[0].text)
  const app = dom.window.fixture
  await app.render(['chapter'])
  t.after(async () => { await app.close(); dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  return app
}

test('a dialog can submit its own transition without releasing another dialog draft', async t => {
  const app = await fixture(t)
  assert.equal(app.guarded(), true)
  await app.run('chapter', async () => assert.equal(app.guarded(), false))
  assert.equal(app.guarded(), true)
  await app.render(['chapter', 'other'])
  await app.run('chapter', async () => assert.equal(app.guarded(), true))
  assert.equal(app.guarded(), true)
})

test('failed submission restores its guard and unmounted submission cannot leave a stale guard', async t => {
  const app = await fixture(t)
  await assert.rejects(app.run('chapter', async () => { throw new Error('save failed') }), /save failed/)
  assert.equal(app.guarded(), true)
  await app.run('chapter', async () => { await app.render([]) })
  assert.equal(app.guarded(), false)
})
