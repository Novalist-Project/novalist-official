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
  import { StructureChapter } from './src/renderer/src/views/manuscript/StructureChapter'
  import { useProjectStore } from './src/renderer/src/stores/projectStore'
  import { flushPendingWrites } from './src/renderer/src/stores/pendingWrites'
  let root
  const chapter = { guid: 'chapter', title: 'Chapter', description: 'Saved', scenes: [] }
  export async function render(collapsed = false) { await act(async () => {
    root ||= createRoot(document.getElementById('host'))
    root.render(<StructureChapter chapter={chapter} collapsed={collapsed} selected={false}
      onToggle={() => {}} onSelect={() => {}} onMove={() => {}} onScene={() => {}} onChapter={() => {}} />)
  }) }
  export async function click(selector) { await act(async () => document.querySelector(selector).click()) }
  export async function edit(text) { await act(async () => {
    const input = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  export async function flush() { await act(async () => flushPendingWrites()) }
  export async function settle() { await act(async () => {}) }
  export async function workspace(update) { await act(async () => useProjectStore.setState(update)) }
  export async function unmount() { if (root) await act(async () => { root.unmount(); root = null }) }
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'summaryFixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'summary-dependencies', setup(builder) {
    const sources = {
      projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({
        projectPath: 'project', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft',
        chapters: [{ guid: 'chapter', description: 'Saved', scenes: [] }] }));`,
      planningStore: `import { create } from 'zustand'; export const usePlanningStore = create(() => ({ state: null, load: async () => {} }));`,
      SceneSynopsisField: `export const SceneSynopsisField = () => null;`,
      'react-i18next': `export const useTranslation = () => ({ t: key => key });`,
      'lucide-react': `export const ChevronDown = () => null; export const ChevronRight = ChevronDown;
        export const GripVertical = ChevronDown; export const Move = ChevronDown; export const Plus = ChevronDown;`,
      client: `export const rpc = { request: (...args) => window.request(...args) };`
    }
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: directory }))
  } }] })

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function fixture(t) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, channels = [], writes = []
  let save = async () => {}
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.request = async (method, args) => { writes.push({ method, args }); await save() }
  w.eval(bundle.outputFiles[0].text)
  const app = w.summaryFixture
  t.after(async () => { save = async () => {}; await app.unmount(); w.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close() } })
  await app.render(); await app.click('.structure-summary-preview')
  return { w, app, writes, save: next => { save = next } }
}

test('collapsing and reopening retains the same summary while its save is pending', async t => {
  const f = await fixture(t), gate = deferred()
  f.save(() => gate.promise)
  await f.app.edit('New summary'); await f.app.render(true)
  assert.equal(f.writes.length, 1)
  await f.app.render(false); await f.app.click('.structure-summary-preview')
  assert.equal(f.w.document.querySelector('textarea').value, 'New summary')
  await f.app.edit('Newest summary')
  gate.resolve(); await f.app.flush()
  assert.deepEqual(f.writes.map(write => write.args[1]), ['New summary', 'Newest summary'])
})

test('failed summary save survives unmount, displays its failure, and retries the newest text', async t => {
  const f = await fixture(t)
  f.save(async () => { throw new Error('Save unavailable') })
  await f.app.edit('Failed summary'); await f.app.click('.structure-summary button')
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Save unavailable/)
  await f.app.render(true); await f.app.render(false); await f.app.click('.structure-summary-preview')
  assert.equal(f.w.document.querySelector('textarea').value, 'Failed summary')
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Save unavailable/)
  await f.app.edit('Retry newest'); f.save(async () => {}); await f.app.flush()
  assert.equal(f.writes.at(-1).args[1], 'Retry newest')
  assert.equal(f.w.document.querySelector('[role="alert"]'), null)
})

test('summary recovery accepts a new transport epoch but refuses another book or draft', async t => {
  const f = await fixture(t)
  await f.app.edit('Recovered summary'); await f.app.workspace({ workspaceEpoch: 2 }); await f.app.flush()
  assert.equal(f.writes.at(-1).args[1], 'Recovered summary')
  await f.app.edit('Original book only'); await f.app.render(true)
  await f.app.workspace({ activeBookId: 'other-book', activeDraftId: 'other-draft' })
  await f.app.render(false); await f.app.click('.structure-summary-preview')
  await f.app.edit('Other workspace')
  await f.app.workspace({ activeBookId: 'third-book' })
  await assert.rejects(f.app.flush(), /workspace/i)
  assert.equal(f.writes.some(write => write.args[1] === 'Other workspace'), false)
})
