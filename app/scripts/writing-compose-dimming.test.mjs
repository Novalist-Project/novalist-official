import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('compose dimming follows selection across retained scenes and clears when disabled', t => {
  const dom = new JSDOM('<div id="editor"><section data-writing-scene="one"><p>First paragraph</p></section><section data-writing-scene="two"><div class="nv-page"><p>Second paragraph</p></div></section></div>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, editor = w.document.getElementById('editor')
  w.NovalistEditorState = { editor, dimOthers: false }
  w.NovalistWritingDocument = { enabled: true }
  w.writingSelectedRanges = () => {
    const selection = w.getSelection(), root = selection.anchorNode?.parentElement.closest('section')
    return root ? [{ root }] : []
  }
  for (const file of ['read-aloud.js', 'formatting.js', 'typewriter-scroll.js']) {
    w.eval(readFileSync(new URL('../src/renderer/public/editor/' + file, import.meta.url), 'utf8'))
  }
  const [first, second] = editor.querySelectorAll('p')
  const select = paragraph => { w.getSelection().collapse(paragraph.firstChild, 3); w.updateFocusBlock() }
  select(first); w.setComposeDimming(true)
  assert.deepEqual([...editor.querySelectorAll('.nv-focus-block')], [first])
  select(second)
  assert.deepEqual([...editor.querySelectorAll('.nv-focus-block')], [second])
  const spoken = w.document.createRange()
  spoken.selectNodeContents(first)
  spoken.getBoundingClientRect = () => ({ top: 80, bottom: 100, height: 20 })
  w.NovalistEditorState.wrapper = { getBoundingClientRect: () => ({ top: 0, bottom: 200, height: 200 }) }
  w.NovalistEditorState.speakingHighlight = new Set()
  w.showSpeaking(spoken)
  assert.deepEqual([...editor.querySelectorAll('.nv-focus-block')], [first])
  w.updateFocusBlock()
  assert.deepEqual([...editor.querySelectorAll('.nv-focus-block')], [second])
  select(first)
  assert.deepEqual([...editor.querySelectorAll('.nv-focus-block')], [first])
  w.setComposeDimming(false)
  assert.equal(editor.querySelectorAll('.nv-focus-block').length, 0)
})
