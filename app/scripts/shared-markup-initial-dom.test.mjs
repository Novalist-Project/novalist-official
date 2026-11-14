import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const bundle = await build({ stdin: { contents: "export * from './src/renderer/src/collaboration/sceneMarkup'; export * from './src/shared/ProseDocumentHost'",
  resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports)
const { SceneMarkup, ProseDocumentHost } = module.exports
const withAttributes = runs => runs.map(run => ({ ...run, attributes: run.attributes ?? {} }))

function fixture(t, paginated) {
  const html = '<p><b>Opening</b> prose</p><p>Second paragraph</p>'
  const dom = new JSDOM('<section contenteditable="true">' + (paginated ? '<div class="nv-page">' + html + '</div>' : html) + '</section>')
  const document = dom.window.document, root = document.querySelector('section')
  const environment = { document, sanitizeSceneFragment(html) {
    const template = document.createElement('template'); template.innerHTML = html; return template.content
  }, toDisplayImages() {}, refreshLayout() {} }
  const host = new ProseDocumentHost(document, environment), doc = new Y.Doc()
  Y.applyUpdate(doc, host.seed('scene', html))
  const markup = new SceneMarkup(environment, root)
  t.after(() => { doc.destroy(); host.dispose(); dom.window.close() })
  return { dom, root, markup, runs: doc.getText('prose').toDelta() }
}

for (const paginated of [false, true]) {
  test(`initial shared binding adopts canonical block identities without replacing prose or page nodes (pages=${paginated})`, t => {
    const { dom, root, markup, runs } = fixture(t, paginated)
    const nodes = [...root.querySelectorAll('*')], text = root.querySelector('b').firstChild
    dom.window.getSelection().setBaseAndExtent(text, 6, text, 2)
    const observer = new dom.window.MutationObserver(() => {})
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true })
    markup.render(runs)
    const actual = [...root.querySelectorAll('*')]
    assert.equal(actual.length, nodes.length)
    actual.forEach((node, index) => assert.equal(node, nodes[index]))
    assert.equal(dom.window.getSelection().anchorNode, text)
    assert.equal(dom.window.getSelection().anchorOffset, 6)
    assert.equal(dom.window.getSelection().focusOffset, 2)
    assert.equal(observer.takeRecords().length, 0)
    assert.deepEqual(markup.read(), withAttributes(runs))
    observer.disconnect()
  })
}

test('different initial content and later peer updates still reconcile the actual DOM', t => {
  const { root, markup, runs } = fixture(t, false)
  root.querySelector('b').textContent = 'Old'
  markup.render(runs)
  assert.equal(root.querySelector('b').textContent, 'Opening')
  const first = root.firstChild
  const updated = runs.map((run, index) => index === 0 ? { ...run, insert: 'Revised' } : run)
  markup.render(updated)
  assert.equal(root.firstChild, first)
  assert.equal(root.querySelector('b').textContent, 'Revised')
  assert.deepEqual(markup.read(), withAttributes(updated))
})
