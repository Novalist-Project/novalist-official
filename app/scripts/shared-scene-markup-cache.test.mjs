import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const result = await build({ stdin: { contents: "export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/shared/ProseDocumentHost'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { SharedSceneSession, ProseDocumentHost } = module.exports

function fixture(t) {
  const dom = new JSDOM('')
  const document = dom.window.document
  let sanitizations = 0
  const environment = { document, sanitizeSceneFragment(html) {
    sanitizations++
    const template = document.createElement('template')
    template.innerHTML = html
    return template.content
  }, toDisplayImages() {} }
  const host = new ProseDocumentHost(document, environment)
  const html = '<p><b>Opening</b> prose</p>' + '<p>Long scene words.</p>'.repeat(312)
  const initial = host.seed('scene', html)
  const server = new Y.Doc()
  Y.applyUpdate(server, initial)
  const owner = new SharedSceneSession(environment, initial, { read: async () => Y.encodeStateAsUpdate(server),
    write: async update => Y.applyUpdate(server, update), subscribe: () => () => {} })
  t.after(async () => { await owner.close(); server.destroy(); host.dispose(); dom.window.close() })
  return { owner, server, html, sanitizations: () => sanitizations }
}

test('repeated caret mapping reuses current rich markup and refreshes after a peer edit', t => {
  const f = fixture(t)
  assert.equal(f.owner.html, f.html)
  const before = f.sanitizations()
  const point = { sceneId: 'scene', offset: 4, affinity: 'after' }
  const retained = f.owner.relativePoint(point)
  for (let index = 0; index < 8; index++) {
    assert.equal(f.owner.resolvePoint(f.owner.relativePoint(point)), 4)
    assert.equal(f.owner.html, f.html)
  }
  assert.equal(f.sanitizations(), before, 'unchanged selection mapping must not sanitize every paragraph again')
  f.server.getText('prose').insert(0, 'Peer ')
  f.owner.receive(Y.encodeStateAsUpdate(f.server))
  assert.equal(f.owner.resolvePoint(retained), 9)
  assert.equal(f.owner.html, f.html.replace('<p>', '<p>Peer '))
  const refreshed = f.sanitizations()
  assert.equal(f.owner.resolvePoint(retained), 9)
  assert.equal(f.sanitizations(), refreshed)
})

test('preparing an uncommitted replacement cannot contaminate current markup or caret mapping', t => {
  const f = fixture(t)
  const retained = f.owner.relativePoint({ sceneId: 'scene', offset: 4, affinity: 'after' })
  assert.equal(f.owner.html, f.html)
  const apply = f.owner.prepareChange('<p>Replacement</p>')
  assert.equal(f.owner.resolvePoint(retained), 4)
  assert.equal(f.owner.html, f.html)
  f.owner.transact(apply)
  assert.equal(f.owner.html, '<p>Replacement</p>')
  assert.equal(f.owner.resolvePoint(f.owner.relativePoint({ sceneId: 'scene', offset: 3, affinity: 'after' })), 3)
})
