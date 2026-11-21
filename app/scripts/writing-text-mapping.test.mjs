import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { writingTextMapping } from '../src/renderer/src/views/editor/writingTextMapping.ts'

test('a paragraph-end caret resolves to its text node before the synthetic newline', () => {
  const dom = new JSDOM('<main><p><strong>Typed prose.</strong></p><p>Next.</p></main>')
  try {
    const root = dom.window.document.querySelector('main')
    const text = root.querySelector('strong').firstChild
    for (const affinity of ['before', 'after']) {
      const point = writingTextMapping.domPoint(root, text.length, affinity)
      assert.equal(point.node, text)
      assert.equal(point.offset, text.length)
      assert.equal(writingTextMapping.offset(root, point.node, point.offset), text.length)
    }
    const next = writingTextMapping.domPoint(root, text.length + 1, 'after')
    assert.equal(next.node, root.lastChild.firstChild)
    assert.equal(next.offset, 0)
  } finally { dom.window.close() }
})

for (const html of ['<p>Caption<img src="x"></p>', '<p><strong>Caption</strong><img src="x"></p>',
  '<p><strong>Caption<img src="x"></strong></p>']) {
  test(`a paragraph-end caret keeps trailing image ownership in ${html}`, () => {
    const dom = new JSDOM(`<main>${html}</main>`)
    try {
      const root = dom.window.document.querySelector('main')
      const point = writingTextMapping.domPoint(root, 7, 'after')
      const before = dom.window.document.createRange()
      before.selectNodeContents(root)
      before.setEnd(point.node, point.offset)
      assert.equal(before.cloneContents().querySelectorAll('img').length, 1)
      assert.equal(writingTextMapping.offset(root, point.node, point.offset), 7)
    } finally { dom.window.close() }
  })
}
