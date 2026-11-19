import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const directory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: { resolveDir: directory, loader: 'tsx', contents: `
    import { act } from 'react'
    import { createRoot } from 'react-dom/client'
    import { FindReplaceDialog } from './src/renderer/src/shell/FindReplaceDialog'
    const root = createRoot(document.body.appendChild(document.createElement('main')))
    export { act }
    export const mount = () => act(async () => root.render(<FindReplaceDialog onClose={() => { window.closedDialog = true }} />))
    export const close = () => act(async () => root.unmount())
  ` },
  bundle: true, write: false, format: 'iife', globalName: 'fixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'dialog-boundaries', setup(builder) {
    const modules = {
      'react-i18next': 'export const useTranslation = () => ({ t: (key, values) => values ? key + JSON.stringify(values) : key })',
      projectStore: 'export const useProjectStore = Object.assign(selector => selector(window.project), { getState: () => window.project })',
      MotionPresence: 'export const useMotionPresent = () => true',
      client: 'export const rpc = { request: (...args) => window.request(...args) }',
      writingSearchHost: `export const findWriting = () => window.search
        export const replaceWriting = (...args) => window.replace(...args)
        export const replaceWritingNotes = () => window.replaceNotes()
        export const revealWritingMatch = () => {}`,
      writingSearchExternal: 'export const hasPendingWritingReplacement = () => false; export const retryWritingReplacement = () => { throw Error("unexpected retry") }'
    }
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (Object.hasOwn(modules, key)) return { path: key, namespace: 'dialog-fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'dialog-fixture' }, args => ({ contents: modules[args.path] }))
  } }]
})

async function dialog(t, mobile = false) {
  const w = new JSDOM('<body></body>', { url: 'http://localhost', runScripts: 'outside-only' }).window
  const channels = []
  w.HTMLElement.prototype.getClientRects = () => [new w.DOMRect(0, 0, 80, 24)]
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this) } }
  w.IS_REACT_ACT_ENVIRONMENT = true
  w.novalist = { isMobile: mobile }
  w.project = { projectPath: 'demo', workspaceEpoch: 1 }
  const prose = ['Tornado Tornado', 'Tornado Tornado Tornado']
  const matches = prose.flatMap((scene, index) => {
    const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: String(index) }
    return [...scene.matchAll(/Tornado/g)].map(hit => ({ ref, field: 'prose', index: hit.index, matchedText: hit[0] }))
  })
  w.search = { targets: [], matches: [...matches, ...['notes', 'synopsis', 'comment', 'codex'].map(field => ({ ...matches[0], field }))] }
  w.replace = (_search, selected, replacement) => {
    const before = [...prose]
    assert.equal(selected.length, 5)
    prose.forEach((scene, i) => { prose[i] = scene.replaceAll('Tornado', replacement) })
    return { count: 5, undo: async () => { prose.splice(0, 2, ...before); return { status: 'applied' } } }
  }
  w.request = (method, args) => {
    if (method === 'search/find') return w.search.matches.map(hit => ({ ...hit, ...hit.ref }))
    assert.equal(method, 'search/replaceAll')
    assert.deepEqual(Array.from(args.at(-1), hit => hit.field), ['prose', 'prose', 'prose', 'prose', 'prose', 'notes', 'synopsis'])
    return 7
  }
  w.replaceNotes = () => 2
  w.eval(bundle.outputFiles[0].text)
  t.after(async () => { await w.fixture.close(); w.close(); for (const ch of channels) { ch.port1.close(); ch.port2.close() } })
  await w.fixture.mount()
  const button = key => [...w.document.querySelectorAll('button')].find(element => !element.closest('[inert]') && element.textContent === key)
  const click = key => w.fixture.act(async () => { assert.ok(button(key), key); button(key).click() })
  const fill = (index, value) => w.fixture.act(async () => {
    const input = w.document.querySelectorAll('input')[index]
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new w.Event('input', { bubbles: true }))
  })
  await fill(0, 'Tornado')
  return { w, prose, button, click, fill }
}

test('five empty prose replacements require confirmation and can be undone in the dialog', async t => {
  const { w, prose, button, click } = await dialog(t)
  const original = [...prose]
  await click('findReplace.find')
  const openConfirmation = () => click('findReplace.deleteMatches')
  await openConfirmation()
  assert.deepEqual(prose, original, 'clicking the bulk action must leave every match intact')
  assert.match(w.document.body.textContent, /findReplace.confirmDeletion.*"count":5.*"scenes":2/)
  assert.equal(w.document.activeElement, button('dialog.cancel'))
  await click('dialog.cancel')
  assert.deepEqual(prose, original)
  await openConfirmation()
  await click('findReplace.deleteMatches')
  assert.deepEqual(prose, [' ', '  '])
  const undo = button('findReplace.undoReplacement')
  assert.equal(w.document.activeElement, undo)
  await w.fixture.act(async () => w.document.querySelector('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })))
  assert.deepEqual(prose, [' ', '  '], 'native undo in the search field must leave the manuscript alone')
  await w.fixture.act(async () => undo.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })))
  assert.deepEqual(prose, original)
})

test('Find is primary and metadata confirmation excludes prose, comments and Codex', async t => {
  const { w, button, click, fill } = await dialog(t)
  assert.ok(button('findReplace.find').classList.contains('primary'))
  await fill(1, 'Storm')
  await w.fixture.act(async () => w.document.querySelectorAll('[type=checkbox]')[3].click())
  await click('findReplace.find')
  await click('findReplace.replaceNotes')
  assert.match(w.document.body.textContent, /findReplace.confirmReplacement.*"count":2.*"scenes":1/)
  await w.fixture.act(async () => w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(w.closedDialog, undefined)
  assert.equal(button('dialog.cancel'), undefined)
  await click('findReplace.replaceNotes')
  await click('findReplace.replaceNotes')
  assert.match(w.document.body.textContent, /findReplace.snapshotRecovery/)
  assert.equal(button('findReplace.undoReplacement'), undefined)
})

test('mobile requires a preview and confirms only the prose and metadata it can change', async t => {
  const { w, button, click, fill } = await dialog(t, true)
  await fill(1, 'Storm')
  assert.equal(button('findReplace.replaceAll').disabled, true)
  await w.fixture.act(async () => w.document.querySelectorAll('[type=checkbox]')[3].click())
  await click('findReplace.find')
  await click('findReplace.replaceAll')
  assert.match(w.document.body.textContent, /findReplace.confirmReplacement.*"count":7.*"scenes":2/)
  Object.assign(w.project, { openChapterGuid: 'chapter', openSceneId: '0', openScene: async () => { throw Error('Refresh failed') } })
  await click('findReplace.replaceAll')
  assert.match(w.document.body.textContent, /findReplace.snapshotRecovery/)
  assert.match(w.document.querySelector('[role="alert"]').textContent, /Refresh failed/)
  assert.equal(button('findReplace.replaceAll').disabled, true)
  assert.equal(button('findReplace.undoReplacement'), undefined)
})
