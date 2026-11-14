import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import * as Y from 'yjs'
import { commentSceneMarkupSource, fragmentSceneMarkupSource } from '../e2e/fixtures/writingSceneMarkupSource.ts'

const sourcePath = resolve('src/renderer/src/collaboration/sceneMarkup.ts')
const bundle = await build({ stdin: { contents: "export { SceneMarkup } from './src/renderer/src/collaboration/sceneMarkup'; export { createSceneSanitizer } from './src/shared/sceneSanitizer'; export { updateRichText } from './src/renderer/src/collaboration/richText'; export { CommentBookmark, wrapCommentLeaves } from './e2e/fixtures/writingComments';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'comment-markup', setup(builder) {
    builder.onLoad({ filter: /sceneMarkup\.ts$/ }, ({ path }) => path === sourcePath
      ? { contents: fragmentSceneMarkupSource(commentSceneMarkupSource(readFileSync(path, 'utf8'))), loader: 'ts' } : undefined)
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { SceneMarkup, createSceneSanitizer, updateRichText, CommentBookmark, wrapCommentLeaves } = module.exports

function fixture(html) {
  const dom = new JSDOM('<main></main>')
  const document = dom.window.document
  const root = document.querySelector('main')
  const sanitizer = createSceneSanitizer(dom.window, createDOMPurify(dom.window))
  root.append(sanitizer.sanitizeSceneFragment(html))
  const markup = new SceneMarkup({ document, ...sanitizer, toDisplayImages() {} }, root)
  return { dom, document, root, markup }
}

test('structural wrapper paths retain mixed descendants and node identity; unsafe path input stays rejected', () => {
  const f = fixture('<a href="https://example.invalid"><span title="legacy">lead<p>alpha</p><p>bravo</p>tail</span></a>')
  try {
    const html = f.root.innerHTML
    const nodes = Array.from(f.root.querySelectorAll('*'))
    const runs = f.markup.read()
    f.markup.render(runs)
    assert.equal(f.root.innerHTML, html)
    assert.ok(nodes.every(node => node.isConnected))
    for (const block of [
      { tag: 'script', attributes: {} }, { tag: 'iframe', attributes: {} },
      { tag: 'span', attributes: { onclick: 'alert(1)' } }, { tag: 'a', attributes: { href: 'javascript:alert(1)' } }
    ]) assert.throws(() => f.markup.validateAttribute('block', JSON.stringify([{ id: 'rejected', ...block }])))
  } finally { f.dom.window.close() }
})

test('comment leaves keep root inline, list, table, links and embeds in their original containers', () => {
  const f = fixture('alpha<a href="https://example.invalid">link<img src="images/synthetic.png"></a><ul><li>bravo</li></ul><table><tbody><tr><td>charlie</td></tr></tbody></table>delta')
  try {
    const nodes = Array.from(f.root.querySelectorAll('*'))
    const parents = nodes.map(node => node.parentNode)
    const selection = f.dom.window.getSelection()
    selection.setBaseAndExtent(f.root.firstChild, 2, f.root.lastChild, 3)
    const bookmark = new CommentBookmark(selection)
    assert.equal(wrapCommentLeaves(selection.getRangeAt(0), 'owned', bookmark), 5)
    bookmark.restore(() => { throw new Error('Unexpected endpoint fallback') })
    assert.ok(nodes.every((node, index) => node.nodeName === 'IMG' ? node.parentNode.className === 'nv-comment' && node.parentNode.parentNode === parents[index] : node.parentNode === parents[index]))
    assert.equal(selection.anchorNode.textContent, 'pha')
    assert.equal(selection.anchorOffset, 0)
    assert.equal(selection.focusNode.textContent, 'del')
    assert.equal(selection.focusOffset, 3)
    const html = f.root.innerHTML
    f.markup.render(f.markup.read())
    assert.equal(f.root.innerHTML, html)
    assert.equal(f.root.querySelectorAll('.nv-comment ul,.nv-comment table,.nv-comment a').length, 0)
  } finally { f.dom.window.close() }
})

test('separate peer documents keep local undo ownership and preserve remote work through comment undo/redo', () => {
  const html = '<p>alpha bravo</p><p>charlie</p>'
  const first = fixture(html), second = fixture(html)
  const writer = {}, peer = {}, remote = {}
  const doc = new Y.Doc(), other = new Y.Doc()
  const text = doc.getText('prose'), peerText = other.getText('prose')
  updateRichText(text, first.markup.read())
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc), remote)
  const history = new Y.UndoManager(text, { trackedOrigins: new Set([writer]) })
  const peerHistory = new Y.UndoManager(peerText, { trackedOrigins: new Set([peer]) })
  const deliver = (from, to) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), remote)
  const render = () => { first.markup.render(text.toDelta()); second.markup.render(peerText.toDelta()) }
  try {
    const selection = first.dom.window.getSelection()
    selection.setBaseAndExtent(first.root.firstChild.firstChild, 2, first.root.lastChild.firstChild, 3)
    wrapCommentLeaves(selection.getRangeAt(0), 'owned', new CommentBookmark(selection))
    doc.transact(() => updateRichText(text, first.markup.read()), writer)
    deliver(doc, other)
    render()
    const annotated = first.root.innerHTML
    assert.equal(second.root.innerHTML, annotated)
    assert.equal(history.undoStack.length, 1)
    assert.equal(peerHistory.undoStack.length, 0)
    other.transact(() => peerText.insert(0, 'remote '), peer)
    deliver(other, doc)
    history.undo()
    deliver(doc, other)
    render()
    assert.equal(first.root.innerHTML, '<p>remote alpha bravo</p><p>charlie</p>')
    assert.equal(second.root.innerHTML, first.root.innerHTML)
    assert.equal(peerHistory.undoStack.length, 1)
    history.redo()
    deliver(doc, other)
    render()
    assert.equal(first.root.innerHTML, annotated.replace('<p>', '<p>remote '))
    assert.equal(second.root.innerHTML, first.root.innerHTML)
    assert.equal(peerHistory.undoStack.length, 1)
  } finally { history.destroy(); peerHistory.destroy(); doc.destroy(); other.destroy(); first.dom.window.close(); second.dom.window.close() }
})
