import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('automatic prose direction preserves explicit data and excludes editor structure', () => {
  const dom = new JSDOM('<div id="editor"><div class="writing-scene"><div class="nv-page"><p>مرحبا English</p><p dir="ltr">مرحبا</p><blockquote style="direction:rtl">English</blockquote><ul><li>مرحبا</li></ul></div><div data-editor-chrome><p>Title</p></div></div></div>', { runScripts: 'outside-only' })
  const w = dom.window
  w.eval(readFileSync(new URL('../src/renderer/public/editor/prose-direction.js', import.meta.url), 'utf8'))
  w.applyProseDirection(w.document.getElementById('editor'))
  assert.equal(w.document.querySelector('p').dir, 'auto')
  assert.equal(w.document.querySelector('p[dir="ltr"]').dir, 'ltr')
  assert.equal(w.document.querySelector('blockquote').dir, 'rtl')
  assert.equal(w.document.querySelector('li').dir, 'rtl')
  assert.equal(w.document.querySelector('.writing-scene').hasAttribute('dir'), false)
  assert.equal(w.document.querySelector('.nv-page').hasAttribute('dir'), false)
  assert.equal(w.document.querySelector('[data-editor-chrome] p').hasAttribute('dir'), false)
  w.close()
})

test('typing never scans untouched scenes and added blocks inherit explicit direction', async () => {
  const dom = new JSDOM('<div id="editor" contenteditable="true"><section id="untouched"><p>English</p></section><section id="active"><ul dir="rtl"><li>English</li></ul><p>مرحبا</p></section></div>', { runScripts: 'outside-only' })
  const w = dom.window
  w.eval(readFileSync(new URL('../src/renderer/public/editor/prose-direction.js', import.meta.url), 'utf8'))
  w.applyProseDirection(w.document.getElementById('editor'))
  assert.equal(w.document.querySelector('li').hasAttribute('dir'), false)
  let scans = 0
  const query = w.Element.prototype.querySelectorAll
  w.Element.prototype.querySelectorAll = function (...args) { scans++; return query.apply(this, args) }
  w.document.querySelector('#active p').firstChild.data += ' عالم'
  w.document.getElementById('editor').dispatchEvent(new w.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  await new Promise(resolve => w.setTimeout(resolve, 0))
  assert.equal(scans, 0)
  const added = w.document.createElement('p')
  added.textContent = 'English'
  w.document.getElementById('active').append(added)
  await new Promise(resolve => w.setTimeout(resolve, 0))
  assert.equal(added.dir, 'auto')
  w.close()
})
