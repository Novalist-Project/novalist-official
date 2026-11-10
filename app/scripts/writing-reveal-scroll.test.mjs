import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = name => readFileSync(new URL(`../src/renderer/public/editor/${name}`, import.meta.url), 'utf8')

function fixture(t) {
  const dom = new JSDOM('<div id="wrapper"><div id="editor" contenteditable="true"><section data-writing-scene="first"><p>First scene</p></section><section data-writing-scene="last"><p>Last scene</p></section></div></div>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, editor = w.document.getElementById('editor'), wrapper = w.document.getElementById('wrapper')
  const frames = [], timers = []
  w.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
  w.setTimeout = (callback, delay) => { assert.equal(delay, 100); timers.push(callback); return timers.length }
  w.sendMessage = () => {}
  w.NovalistEditorState = { editor, wrapper, savedScrollTop: 500, isFocusing: false }
  w.getWritingSceneRoot = id => editor.querySelector(`[data-writing-scene="${id}"]`)
  for (const [id, top] of [['first', 0], ['last', 800]]) {
    w.getWritingSceneRoot(id).querySelector('p').scrollIntoView = () => { wrapper.scrollTop = top }
  }
  wrapper.scrollTop = 500
  w.eval(source('writing-selection.js'))
  w.eval(source('clipboard-focus-events.js'))
  editor.dispatchEvent(new w.FocusEvent('focus'))
  return { w, editor, wrapper, frames, timers,
    finishFocus: () => { for (const callback of frames) callback(); for (const callback of timers) callback() } }
}

test('explicit writing reveal wins over pending focus scroll restoration', t => {
  const { w, wrapper, finishFocus } = fixture(t)
  w.revealWritingPoint({ sceneId: 'first', offset: 0, affinity: 'after' })
  assert.equal(wrapper.scrollTop, 0)
  finishFocus()
  assert.equal(wrapper.scrollTop, 0)
  assert.equal(w.getWritingSelection().focus.sceneId, 'first')
})

test('focus-only restoration still prevents an unsolicited browser scroll jump', t => {
  const { w, wrapper, finishFocus } = fixture(t)
  wrapper.scrollTop = 0
  finishFocus()
  assert.equal(wrapper.scrollTop, 500)
  assert.equal(w.NovalistEditorState.isFocusing, false)
})

test('the newest explicit reveal owns scroll while an older focus callback remains queued', t => {
  const { w, wrapper, finishFocus } = fixture(t)
  w.revealWritingPoint({ sceneId: 'first', offset: 0, affinity: 'after' })
  w.revealWritingPoint({ sceneId: 'last', offset: 0, affinity: 'after' })
  finishFocus()
  assert.equal(wrapper.scrollTop, 800)
  assert.equal(w.getWritingSelection().focus.sceneId, 'last')
})

test('native scroll anchoring after an explicit reveal survives the old focus timer', t => {
  const { w, wrapper, finishFocus } = fixture(t)
  w.revealWritingPoint({ sceneId: 'last', offset: 0, affinity: 'after' })
  wrapper.scrollTop = 1080
  wrapper.dispatchEvent(new w.Event('scroll'))
  finishFocus()
  assert.equal(wrapper.scrollTop, 1080)
  assert.equal(w.NovalistEditorState.savedScrollTop, 1080)
})

test('superseded focus callbacks cannot restore or end a newer focus cycle', t => {
  const { w, editor, wrapper, frames, timers } = fixture(t)
  w.revealWritingPoint({ sceneId: 'last', offset: 0, affinity: 'after' })
  editor.dispatchEvent(new w.FocusEvent('focus'))
  wrapper.scrollTop = 0
  frames[0]()
  timers[0]()
  assert.equal(wrapper.scrollTop, 0)
  assert.equal(w.NovalistEditorState.isFocusing, true)
  frames[1]()
  assert.equal(wrapper.scrollTop, 800)
  timers[1]()
  assert.equal(w.NovalistEditorState.isFocusing, false)
})
