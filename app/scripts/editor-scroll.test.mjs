import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const editorDirectory = new URL('../src/renderer/public/editor/', import.meta.url)
const scripts = [...readFileSync(new URL('editor.html', editorDirectory), 'utf8').matchAll(/<script src="([^"]+)"/g)]
  .map(match => match[1])
  .filter(name => ['writing-scroll.js', 'typewriter-scroll.js', 'grammar-highlights.js',
    'clipboard-focus-events.js', 'context-menu-actions.js', 'context-menu-events.js'].includes(name))

function editorFixture(t) {
  const dom = new JSDOM('<div id="editor-wrapper"><div id="editor"><p>Aelthorn</p></div></div><div id="context-menu"></div>', { runScripts: 'outside-only', pretendToBeVisual: true })
  t.after(() => dom.window.close())
  const { window } = dom
  const editor = window.document.getElementById('editor')
  const wrapper = window.document.getElementById('editor-wrapper')
  const menu = window.document.getElementById('context-menu')
  editor.tabIndex = 0
  editor.focus()
  let now = 1_000
  window.Date.now = () => now
  let top = 100
  Object.defineProperties(wrapper, {
    clientHeight: { value: 600 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(1_000, value)) } }
  })
  wrapper.getBoundingClientRect = () => ({ top: 0 })
  window.Range.prototype.getBoundingClientRect = () => ({ top: 100 - top, bottom: 120 - top })
  window.getSelection().setPosition(editor.querySelector('p').firstChild, 4)
  window.NovalistEditorState = { editor, wrapper, typewriterSuspendUntil: 0 }
  window.updateFloatingToolbar = () => {}
  const messages = []
  window.sendMessage = message => messages.push(message)
  for (const name of scripts) window.eval(readFileSync(new URL(name, editorDirectory), 'utf8'))
  return {
    window, editor, wrapper, menu, messages,
    advance(milliseconds) { now += milliseconds },
    openMenu() {
      menu.innerHTML = '<div class="cm-item" data-action="addToDictionary" data-word="Aelthorn">Add to Dictionary</div>'
      menu.classList.add('visible')
    },
    deliverScroll() { wrapper.dispatchEvent(new window.Event('scroll')) }
  }
}

test('a delayed caret scroll keeps the dictionary menu actionable', t => {
  const fixture = editorFixture(t)
  fixture.window.recenterCaret()
  assert.equal(fixture.wrapper.scrollTop, 60)
  fixture.advance(250)
  fixture.openMenu()
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), true)
  fixture.menu.querySelector('[data-action="addToDictionary"]').click()
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.messages)), [{ type: 'addToDictionary', word: 'Aelthorn' }])
})

test('focus restoration keeps an open menu through delayed scroll delivery', t => {
  const fixture = editorFixture(t)
  fixture.window.NovalistEditorState.savedScrollTop = 200
  fixture.editor.dispatchEvent(new fixture.window.FocusEvent('focus'))
  assert.equal(fixture.wrapper.scrollTop, 200)
  fixture.advance(250)
  fixture.openMenu()
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), true)
})

for (const { name, positions, finalTop } of [
  { name: 'coalesced writes', positions: [40, 60], finalTop: 60 },
  { name: 'a no-op after a pending write', positions: [60, 60], finalTop: 60 },
  { name: 'a clamped write', positions: [2_000], finalTop: 1_000 },
  { name: 'a clamped no-op after a pending write', positions: [2_000, 2_000], finalTop: 1_000 }
]) test(`${name} preserves the menu only until the next manual scroll`, t => {
  const fixture = editorFixture(t)
  for (const position of positions) fixture.window.setWritingScroll(position)
  assert.equal(fixture.wrapper.scrollTop, finalTop)
  fixture.advance(1_000)
  fixture.openMenu()
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), true)
  fixture.wrapper.scrollTop = finalTop - 10
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), false)
})

test('a no-op scroll does not suppress the next manual scroll', t => {
  const fixture = editorFixture(t)
  fixture.window.setWritingScroll(100)
  fixture.openMenu()
  fixture.wrapper.scrollTop = 120
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), false)
})

test('manual scrolling before a pending event still dismisses the menu', t => {
  const fixture = editorFixture(t)
  fixture.window.setWritingScroll(60)
  fixture.openMenu()
  fixture.wrapper.scrollTop = 120
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), false)
})

test('a wheel gesture ends suppression even when scrolling returns to the pending position', t => {
  const fixture = editorFixture(t)
  fixture.window.setWritingScroll(60)
  fixture.openMenu()
  fixture.wrapper.dispatchEvent(new fixture.window.WheelEvent('wheel', { deltaY: 20 }))
  fixture.wrapper.scrollTop = 80
  fixture.wrapper.scrollTop = 60
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), false)
})

test('right-clicking to open a menu does not cancel pending programmatic scrolling', t => {
  const fixture = editorFixture(t)
  fixture.window.recenterCaret()
  fixture.editor.dispatchEvent(new fixture.window.MouseEvent('pointerdown', { bubbles: true, button: 2 }))
  fixture.advance(250)
  fixture.openMenu()
  fixture.deliverScroll()
  assert.equal(fixture.menu.classList.contains('visible'), true)
})
