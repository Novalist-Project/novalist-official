import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

function fixture(t, scrollEnd = true) {
  const dom = new JSDOM('<div id="wrapper"><div id="editor"><p><span class="grammar-issue" data-issue-type="grammar" data-issue-index="0">First</span> <span class="grammar-issue" data-issue-type="grammar" data-issue-index="1">Second</span></p></div></div><div id="grammar-popup"><div class="gp-message"></div><div class="gp-suggestions"></div><button class="gp-dismiss"></button></div><div id="grammar-status-bar"></div><button id="status-grammar-count-container"></button><button id="status-punctuation-count-container"></button>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, editor = w.document.getElementById('editor'), wrapper = w.document.getElementById('wrapper')
  let now = 0, sequence = 0
  const timers = new Map()
  w.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id }
  w.clearTimeout = id => timers.delete(id)
  if (scrollEnd) wrapper.onscrollend = null
  else for (let owner = wrapper; owner; owner = Object.getPrototypeOf(owner)) delete owner.onscrollend
  w.NovalistEditorState = { editor, wrapper, contextMenuLabels: {}, grammarIssues: [] }
  for (const name of ['grammar-corrections.js', 'proofing-toolbar.js', 'grammar-events.js']) {
    w.eval(readFileSync(new URL(`../src/renderer/public/editor/${name}`, import.meta.url), 'utf8'))
  }
  w.NovalistEditorState.grammarIssues = [
    { type: 'grammar', message: 'First correction', replacements: [] },
    { type: 'grammar', message: 'Second correction', replacements: [] }
  ]
  for (const mark of editor.querySelectorAll('.grammar-issue')) mark.scrollIntoView = () => {}
  const advance = duration => {
    const end = now + duration
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].callback()
    }
    now = end
  }
  const popup = w.document.getElementById('grammar-popup')
  return { w, editor, wrapper, advance, popup,
    scroll: top => { wrapper.scrollTop = top; wrapper.dispatchEvent(new w.Event('scroll')) },
    finish: () => wrapper.dispatchEvent(new w.Event('scrollend')),
    visible: () => popup.classList.contains('visible') }
}

test('proofing navigation waits for a long smooth scroll and later manual scrolling still dismisses', t => {
  const { w, advance, scroll, finish, visible, popup } = fixture(t)
  w.scrollToNextIssue('grammar')
  scroll(100)
  advance(160)
  assert.equal(visible(), false)
  scroll(200)
  advance(160)
  assert.equal(visible(), false)
  finish()
  assert.equal(visible(), true)
  assert.equal(popup.querySelector('.gp-message').textContent, 'First correction')
  scroll(210)
  assert.equal(visible(), false)
})

test('proofing navigation opens when no scroll event is needed', t => {
  const { w, advance, visible } = fixture(t)
  w.scrollToNextIssue('grammar')
  advance(150)
  assert.equal(visible(), true)
})

test('a later proofing navigation supersedes the earlier target', t => {
  const { w, editor, advance, finish, popup } = fixture(t)
  w.scrollToNextIssue('grammar')
  editor.querySelector('.grammar-issue').remove()
  w.scrollToNextIssue('grammar')
  finish()
  advance(200)
  assert.equal(popup.querySelector('.gp-message').textContent, 'Second correction')
})

for (const cancel of ['context', 'results', 'dismiss', 'detach', 'wheel', 'pointerdown', 'touchstart', 'keydown']) {
  test(`pending proofing navigation cannot reopen after ${cancel}`, t => {
    const { w, editor, advance, finish, visible } = fixture(t)
    w.scrollToNextIssue('grammar')
    if (cancel === 'context') {
      w.NovalistEditorState.grammarIssues = []
      w.hideGrammarPopup()
    } else if (cancel === 'results') w.NovalistEditorState.grammarIssues = [{ type: 'grammar', message: 'New result' }]
    else if (cancel === 'dismiss') w.hideGrammarPopup()
    else if (cancel === 'detach') editor.replaceChildren()
    else w.document.dispatchEvent(new w.Event(cancel, { bubbles: true }))
    finish()
    advance(300)
    assert.equal(visible(), false)
  })
}

test('opening another issue directly cancels a pending navigation', t => {
  const { w, advance, finish, popup } = fixture(t)
  w.scrollToNextIssue('grammar')
  w.showGrammarPopup(1, 0, 0)
  finish()
  advance(300)
  assert.equal(popup.querySelector('.gp-message').textContent, 'Second correction')
})

test('legacy browsers without scrollend wait until scrolling settles', t => {
  const { w, advance, scroll, visible } = fixture(t, false)
  w.scrollToNextIssue('grammar')
  scroll(100)
  advance(100)
  scroll(200)
  advance(100)
  assert.equal(visible(), false)
  advance(50)
  assert.equal(visible(), true)
})
