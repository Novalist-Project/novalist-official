import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

const base = new URL('../src/renderer/public/editor/', import.meta.url)

function setup(t, html = '<p>First paragraph</p><p>Second paragraph</p>') {
  const source = readFileSync(new URL('editor.html', base), 'utf8')
  const dom = new JSDOM(source, { runScripts: 'outside-only', pretendToBeVisual: true })
  t.after(() => dom.window.close())
  const w = dom.window
  const editor = w.document.getElementById('editor')
  editor.innerHTML = html
  w.NovalistEditorState = {
    editor, PARAGRAPH_STYLE_PREFIX: 'nv-style-',
    contextMenu: w.document.getElementById('context-menu'), contextMenuLabels: {},
  }
  w.document.queryCommandState = () => false
  w.findEntityAtCaret = () => null
  w.proseBlocks = () => [...editor.children]
  w.blockOf = node => node.nodeType === 3 ? node.parentElement : node
  const messages = []
  w.sendMessage = message => messages.push(message)
  w.Range.prototype.getBoundingClientRect = () => ({ left: 30, top: 80, bottom: 100, width: 150, height: 20 })
  for (const name of ['formatting.js', 'proofing-toolbar.js', 'selection-toolbar-events.js']) {
    w.eval(readFileSync(new URL(name, base), 'utf8'))
  }
  return { w, editor, messages }
}

test('style picker restores backward selection after native select takes focus', t => {
  const { w, editor, messages } = setup(t)
  const text = editor.firstChild.firstChild
  const selection = w.getSelection()
  selection.setBaseAndExtent(text, 10, text, 2)
  w.openQuickEdit()
  const picker = w.document.getElementById('ft-style')
  picker.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }))
  selection.removeAllRanges()
  picker.value = 'heading'
  picker.dispatchEvent(new w.Event('change', { bubbles: true }))
  assert.equal(editor.firstChild.className, 'nv-style-heading')
  assert.equal(selection.anchorNode, text)
  assert.equal(selection.anchorOffset, 10)
  assert.equal(selection.focusOffset, 2)
  assert.equal(messages.some(message => message.type === 'writingStructureRequested'), false)
})

test('empty caret offers body style and Escape restores editor focus', t => {
  const { w, editor } = setup(t, '<p><br></p>')
  const range = w.document.createRange()
  range.setStart(editor.firstChild, 0)
  range.collapse(true)
  w.getSelection().addRange(range)
  w.openQuickEdit()
  const picker = w.document.getElementById('ft-style')
  assert.equal(picker.value, '')
  assert.equal(w.document.activeElement, picker)
  picker.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(w.document.activeElement, editor)
  assert.equal(w.NovalistEditorState.floatingToolbar.classList.contains('visible'), false)
  // Chromium can normalize the same empty caret after focus returns.
  w.getSelection().setBaseAndExtent(editor.firstChild.firstChild, 0, editor.firstChild.firstChild, 0)
  w.updateFloatingToolbar()
  assert.equal(w.NovalistEditorState.quickEditDismissed, true)
})

test('mixed paragraph styles have a distinct label; native picker events remain usable', t => {
  const { w, editor } = setup(t, '<p class="nv-style-heading">First</p><p>Second</p>')
  w.getSelection().setBaseAndExtent(editor.firstChild.firstChild, 0, editor.lastChild.firstChild, 6)
  w.updateFloatingToolbar()
  const picker = w.document.getElementById('ft-style')
  assert.equal(picker.value, 'mixed')
  const pointer = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  picker.dispatchEvent(pointer)
  assert.equal(pointer.defaultPrevented, false)
})

test('structural choices require a writing host and send an explicit command', t => {
  const { w, editor, messages } = setup(t)
  w.getSelection().setBaseAndExtent(editor.firstChild.firstChild, 3, editor.firstChild.firstChild, 3)
  w.openQuickEdit()
  const picker = w.document.getElementById('ft-structure')
  assert.equal(picker.hidden, true)
  w.setWritingStructureEnabled(true)
  picker.value = 'sceneBreak'
  picker.dispatchEvent(new w.Event('change', { bubbles: true }))
  assert.equal(messages.filter(message => message.type === 'writingStructureRequested').length, 1)
  assert.equal(messages.at(-1).command, 'sceneBreak')
  assert.equal(w.getSelection().anchorOffset, 3)
  assert.equal(editor.children.length, 2)
})
