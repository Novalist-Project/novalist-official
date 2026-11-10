import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { fragmentSceneMarkupSource } from '../e2e/fixtures/writingSceneMarkupSource.ts'

const sourcePath = resolve('src/renderer/src/collaboration/sceneMarkup.ts')
const bundle = await build({ stdin: { contents: "export { SceneMarkup } from './src/renderer/src/collaboration/sceneMarkup'; export { createSceneSanitizer } from './src/shared/sceneSanitizer'; export * as surfaces from './e2e/fixtures/writingSceneSurface'; export { installSceneCapture } from './e2e/fixtures/writingSceneCapture'; export { installFragmentInput } from './e2e/fixtures/writingFragmentInput';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'fragment-markup', setup(builder) {
    builder.onLoad({ filter: /sceneMarkup\.ts$/ }, ({ path }) => path === sourcePath
      ? { contents: fragmentSceneMarkupSource(readFileSync(path, 'utf8')), loader: 'ts' } : undefined)
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { SceneMarkup } = module.exports
const { SceneProjection } = module.exports.surfaces

function fixture(html, sanitize = false) {
  const dom = new JSDOM('<main><section></section></main>')
  const document = dom.window.document
  const root = document.querySelector('section')
  root.innerHTML = html
  const environment = { document, sanitizeSceneFragment(value) {
    const template = document.createElement('template')
    template.innerHTML = value
    return template.content
  }, toDisplayImages() {} }
  if (sanitize) Object.assign(environment, module.exports.createSceneSanitizer(dom.window, createDOMPurify(dom.window)))
  const markup = new SceneMarkup(environment, root)
  const fragments = [root]
  const surface = { sceneId: 'owner', fragments, visible: true,
    atoms: () => fragments.flatMap(fragment => Array.from(fragment.childNodes)),
    insertBefore(node, next) { (next?.parentNode ?? fragments.at(-1)).insertBefore(node, next) },
    remove(node) { node.remove() } }
  const split = index => {
    const next = document.createElement('section')
    root.parentNode.appendChild(next)
    Array.from(root.childNodes).slice(index).forEach(node => next.appendChild(node))
    fragments.push(next)
    markup.attachSurface?.(surface)
  }
  return { dom, document, root, markup, surface, split }
}

test('live scene sequence retains inline continuation, author marks and exact position aliases across fragments', () => {
  const f = fixture('alpha <em title="keep">beta</em><p>block</p>tail<strong>end</strong>')
  const before = f.markup.read()
  const atoms = Array.from(f.root.childNodes)
  const boundaries = atoms.map((_, index) => f.markup.position(f.root, index))
  boundaries.push(f.markup.position(f.root, atoms.length))
  const walker = f.document.createTreeWalker(f.root, f.dom.window.NodeFilter.SHOW_TEXT)
  const positions = []
  while (walker.nextNode()) for (let offset = 0; offset <= walker.currentNode.length; offset++) positions.push({ node: walker.currentNode, offset, index: f.markup.position(walker.currentNode, offset) })
  f.split(1)
  assert.deepEqual(f.markup.read(), before)
  for (const point of positions) assert.equal(f.markup.position(point.node, point.offset), point.index)
  assert.equal(f.markup.position(f.surface.fragments[0], 1), boundaries[1])
  for (let index = 0; index < f.surface.fragments[1].childNodes.length + 1; index++) assert.equal(f.markup.position(f.surface.fragments[1], index), boundaries[index + 1])
  assert.ok(positions.every(point => point.node.isConnected))
  f.dom.window.close()
})

test('fragment patch reserves keyed blocks before unkeyed matches and leaves unchanged nodes in their live fragments', () => {
  const f = fixture('<p>alpha</p><p>bravo</p>')
  const before = f.markup.read()
  const original = Array.from(f.root.childNodes)
  f.split(1)
  f.markup.render([{ insert: 'lead', attributes: { 'p::0': '{}', markOrder: '["p::0"]' } }, { insert: '\n', attributes: { block: '[]' } }, ...before])
  assert.deepEqual(f.surface.atoms().map(node => node.outerHTML), ['<p>lead</p>', '<p>alpha</p>', '<p>bravo</p>'])
  assert.equal(f.surface.atoms()[1], original[0])
  assert.equal(f.surface.atoms()[2], original[1])
  assert.equal(original[0].parentNode, f.surface.fragments[0])
  assert.equal(original[1].parentNode, f.surface.fragments[1])
  f.dom.window.close()
})

for (const split of [false, true]) test(`reverse keyed blocks retain identity and rich order, surface ${split}`, () => {
  const f = fixture('<p title="first">alpha <em>one</em></p><p>bravo</p><p>charlie <strong>three</strong></p>')
  const original = Array.from(f.root.childNodes)
  const groups = []
  let group = []
  for (const run of f.markup.read()) {
    group.push(run)
    if (run.insert.endsWith('\n')) { groups.push(group); group = [] }
  }
  assert.equal(groups.length, 3)
  assert.equal(group.length, 0)
  if (split) f.split(2)
  const requested = groups.reverse().flat()
  f.markup.render(requested)
  assert.deepEqual(f.surface.atoms(), original.toReversed())
  assert.deepEqual(f.markup.read(), requested)
  const observer = new f.dom.window.MutationObserver(() => {})
  observer.observe(f.root.parentNode, { childList: true, subtree: true, characterData: true })
  f.markup.render(requested)
  assert.deepEqual(observer.takeRecords(), [])
  observer.disconnect()
  f.dom.window.close()
})

test('unadapted element contract continues to read and render ordinary authored content', () => {
  const f = fixture('<p title="keep">alpha <em>beta</em></p>tail')
  const atoms = Array.from(f.root.childNodes)
  const runs = f.markup.read()
  f.markup.render(runs)
  assert.equal(f.root.innerHTML, '<p title="keep">alpha <em>beta</em></p>tail')
  assert.ok(atoms.every((node, index) => f.root.childNodes[index] === node))
  f.dom.window.close()
})

for (const split of [false, true]) test(`contextual table factory preserves nested supported blocks and sanitization, surface ${split}`, () => {
  const html = '<table title="keep" onclick="bad()"><thead><tr><th scope="col">head</th></tr></thead><tbody><tr><td colspan="2" onmouseover="bad()"><p>body <a href="javascript:bad()">link</a><script>bad()</script></p></td></tr></tbody><tfoot><tr><td>foot</td></tr></tfoot></table>'
  const source = fixture(html, true)
  const peer = fixture('', true)
  if (split) { source.split(1); peer.split(0) }
  const runs = source.markup.read()
  peer.markup.render(runs)
  source.markup.render(runs)
  const expected = '<table title="keep"><thead><tr><th scope="col">head</th></tr></thead><tbody><tr><td colspan="2"><p>body <a>link</a></p></td></tr></tbody><tfoot><tr><td>foot</td></tr></tfoot></table>'
  const output = f => f.surface.atoms().map(node => node.outerHTML).join('')
  assert.equal(output(source), expected)
  assert.equal(output(peer), expected)
  source.dom.window.close()
  peer.dom.window.close()
})

test('registered scene owners include live and pending removed atoms without trusting imported lookalikes', () => {
  assert.equal(typeof SceneProjection, 'function', 'logical scene projection must exist')
  const dom = new JSDOM('<main><section><p>alpha</p><section data-scene-id="forged" data-writing-fragment=""><b>kept</b></section></section></main>')
  const root = dom.window.document.querySelector('main')
  const fragment = root.firstElementChild
  const atoms = Array.from(fragment.childNodes)
  const projection = new SceneProjection(root)
  const scene = projection.create('owner', fragment)
  assert.equal(projection.owner(atoms[0].firstChild), scene)
  assert.equal(projection.owner(atoms[1].firstChild), scene)
  const page = projection.page()
  const next = projection.fragment(scene, page)
  scene.insertBefore(atoms[1], null)
  assert.equal(atoms[1].parentNode, next)
  assert.deepEqual(scene.atoms(), atoms)
  assert.equal(projection.serialize(scene), '<p>alpha</p><section data-scene-id="forged" data-writing-fragment=""><b>kept</b></section>')
  scene.remove(atoms[0])
  assert.equal(projection.owner(atoms[0].firstChild), scene)
  assert.equal(projection.isFragment(atoms[1]), false)
  projection.dispose()
  assert.equal(projection.owner(atoms[1]), null)
  dom.window.close()
})

test('page and fragment offsets keep explicit boundary affinity and same-scene slices', () => {
  assert.equal(typeof SceneProjection, 'function', 'logical scene projection must exist')
  const dom = new JSDOM('<main><section><p>alpha</p><p>bravo</p></section><section><p>charlie</p></section></main>')
  const root = dom.window.document.querySelector('main')
  const projection = new SceneProjection(root)
  const first = projection.create('first', root.children[0])
  const second = projection.create('second', root.children[1])
  const firstAtoms = first.atoms()
  const page = projection.page()
  const next = projection.fragment(first, page)
  first.insertBefore(firstAtoms[1], null)
  page.appendChild(second.fragments[0])
  const forward = projection.locate(page, 1, 'forward')
  const backward = projection.locate(page, 1, 'backward')
  assert.equal(forward.scene, second)
  assert.equal(backward.scene, first)
  assert.equal(backward.node, next)
  assert.equal(backward.offset, 1)
  const range = dom.window.document.createRange()
  range.setStart(firstAtoms[0].firstChild, 2)
  range.setEnd(firstAtoms[1].firstChild, 3)
  const slices = projection.slices(range)
  assert.equal(slices.length, 1)
  assert.equal(slices[0].scene, first)
  assert.deepEqual(slices[0].ranges.map(part => part.toString()), ['pha', 'bra'])
  projection.visible(second, false)
  assert.equal(projection.locate(second.fragments[0].firstChild.firstChild, 0), null)
  dom.window.close()
})

test('capture owns one logical scene across fragments and maps grammar against the actual ordered nodes', () => {
  const dom = new JSDOM('<main id="editor"><section><p>alpha</p><p>bravo</p></section></main>')
  const editor = dom.window
  globalThis.MutationObserver = editor.MutationObserver
  const root = editor.document.querySelector('main')
  const projection = new SceneProjection(root)
  const scene = projection.create('owner', root.firstElementChild)
  const nodes = scene.atoms()
  const page = projection.page()
  const second = projection.fragment(scene, page)
  projection.presentation.append(second, nodes[1])
  editor.NovalistEditorState = { isComposing: false, isSettingContent: false }
  editor.getCleanContentHtml = target => target.innerHTML
  editor.buildGrammarPlainTextMap = (target, ordered) => ({ plainText: '', textNodes: Array.from(ordered ?? target.childNodes) })
  const publications = []
  editor.sendMessage = message => publications.push(message)
  const acknowledge = module.exports.installSceneCapture(editor, projection.presentation, projection)
  editor.getSelection().setBaseAndExtent(nodes[1].firstChild, 2, nodes[1].firstChild, 2)
  assert.equal(editor.getCleanContentHtml(), '<p>alpha</p><p>bravo</p>')
  assert.deepEqual(editor.buildGrammarPlainTextMap().textNodes, nodes)
  nodes[1].firstChild.data = 'bravo!'
  editor.reportContentChanged()
  assert.equal(publications.length, 1)
  assert.equal(publications[0].sceneId, 'owner')
  assert.equal(publications[0].html, '<p>alpha</p><p>bravo!</p>')
  const accept = acknowledge(scene.fragments[0])
  nodes[0].firstChild.data = 'remote'
  accept()
  editor.reportContentChanged()
  assert.equal(publications.length, 1, 'pure remote render must not echo')
  nodes[1].firstChild.data = 'local'
  const pending = acknowledge(scene.fragments[0])
  nodes[0].firstChild.data = 'remote again'
  pending()
  editor.reportContentChanged()
  assert.equal(publications.length, 2, 'pending local change must survive acknowledgement')
  dom.window.close()
  delete globalThis.MutationObserver
})

for (const lifetime of ['matching', 'canceled', 'mismatched', 'next-operation', 'disposed']) test(`native paragraph intent ledger: ${lifetime}`, () => {
  const dom = new JSDOM('<main><section>bravo</section></main>')
  const { document, InputEvent } = dom.window
  const root = document.querySelector('main')
  const fragment = root.firstElementChild
  const projection = new SceneProjection(root)
  const scene = projection.create('owner', fragment)
  const text = fragment.firstChild
  const input = module.exports.installFragmentInput(projection)
  dom.window.getSelection().setBaseAndExtent(text, 2, text, 2)
  if (lifetime === 'canceled') root.addEventListener('beforeinput', event => event.preventDefault(), { once: true })
  root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }))
  if (lifetime === 'mismatched') root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }))
  if (lifetime === 'next-operation') root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true, cancelable: true }))
  if (lifetime === 'disposed') input.dispose()
  const clone = fragment.cloneNode(false)
  text.data = 'avo'
  fragment.insertBefore(document.createTextNode('br'), text)
  clone.appendChild(text)
  fragment.after(clone)
  dom.window.getSelection().setBaseAndExtent(text, 0, text, 0)
  root.dispatchEvent(new InputEvent('input', { inputType: 'insertParagraph', bubbles: true }))
  if (lifetime === 'matching') {
    assert.equal(projection.serialize(scene), 'br<div>avo</div>')
    assert.equal(dom.window.getSelection().anchorNode, text)
    assert.equal(dom.window.getSelection().anchorOffset, 0)
  } else {
    assert.equal(clone.parentNode, root, 'stale intent must not claim a later copied wrapper')
    assert.equal(clone.firstChild, text)
  }
  input.dispose()
  dom.window.close()
})

for (const change of ['unrelated-text', 'reordered-suffix']) test(`native mixed paragraph reconciliation: ${change}`, () => {
  const dom = new JSDOM('<main><section><p>prefix</p>bravo<em>tail</em><p>after</p></section></main>')
  const { document, InputEvent } = dom.window
  const root = document.querySelector('main')
  const fragment = root.firstElementChild
  const projection = new SceneProjection(root)
  const scene = projection.create('owner', fragment)
  const [prefix, text, tail, after] = Array.from(fragment.childNodes)
  const input = module.exports.installFragmentInput(projection)
  const errors = []
  dom.window.addEventListener('error', event => { errors.push(event.message); event.preventDefault() })
  dom.window.getSelection().setBaseAndExtent(text, 2, text, 2)
  root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }))
  const clone = fragment.cloneNode(false)
  text.data = 'avo'
  fragment.insertBefore(document.createTextNode('br'), text)
  clone.append(text, ...(change === 'reordered-suffix' ? [after, tail] : [tail, after]))
  fragment.after(clone)
  if (change === 'unrelated-text') prefix.firstChild.data = 'independent'
  root.dispatchEvent(new InputEvent('input', { inputType: 'insertParagraph', bubbles: true }))
  if (change === 'unrelated-text') {
    assert.equal(projection.serialize(scene), '<p>independent</p>br<div>avo<em>tail</em></div><p>after</p>')
    assert.deepEqual(errors, [])
  } else {
    assert.deepEqual(errors, ['Unsupported native fragment paragraph topology'])
    assert.equal(clone.parentNode, root)
    assert.throws(() => projection.serialize(scene), /Unsupported native fragment paragraph topology/)
  }
  assert.ok([prefix, text, tail, after].every(node => node.isConnected))
  input.dispose()
  dom.window.close()
})

test('raw Start cannot adopt a pre-existing authored BR moved from a nested paragraph', () => {
  const dom = new JSDOM('<main><section>bravo<p><br></p></section></main>')
  const { document, InputEvent } = dom.window
  const root = document.querySelector('main'), fragment = root.firstElementChild
  const projection = new SceneProjection(root)
  const scene = projection.create('owner', fragment)
  const text = fragment.firstChild, existing = fragment.querySelector('br')
  const input = module.exports.installFragmentInput(projection)
  const errors = []
  dom.window.addEventListener('error', event => { errors.push(event.message); event.preventDefault() })
  dom.window.getSelection().setBaseAndExtent(text, 0, text, 0)
  root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true }))
  const clone = fragment.cloneNode(false)
  clone.append(existing)
  fragment.before(clone)
  root.dispatchEvent(new InputEvent('input', { inputType: 'insertParagraph', bubbles: true }))
  assert.deepEqual(errors, ['Unsupported native fragment paragraph topology'])
  assert.equal(clone.firstChild, existing)
  assert.throws(() => projection.serialize(scene), /Unsupported native fragment paragraph topology/)
  input.dispose()
  dom.window.close()
})
