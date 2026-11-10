import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { loadRendererSource } from './renderer-source-loader.mjs'

test('canvas token refresh preserves pane-specific Focus paper and ink through a resize', t => {
  const host = new JSDOM(), frame = new JSDOM()
  t.after(() => { host.window.close(); frame.window.close() })
  const values = new Map([
    ['--nl-focus-page', '#fffaf1'], ['--nl-focus-ink', '#111111'],
    ['--nl-writing-min-prose', '320px'], ['--nl-writing-margin-expanded', '176px'],
    ['--nl-writing-gap', '12px'], ['--nl-border', '#aaaaaa']
  ])
  const tokens = { [Symbol.iterator]: () => values.keys(), getPropertyValue: key => values.get(key) ?? '' }
  const effects = []
  const { useWritingCanvasStyles } = loadRendererSource('src/views/editor/useWritingCanvas.ts', {
    react: { useState: () => [false, () => {}], useEffect: effect => effects.push(effect) },
    './writing-canvas.css?inline': { default: '' },
    './writingSceneRails': { followWritingSceneRails: () => () => {} }
  }, { document: host.window.document, getComputedStyle: () => tokens, MutationObserver: host.window.MutationObserver })
  const root = frame.window.document.documentElement
  root.style.setProperty('--nl-focus-page', '#203040')
  root.style.setProperty('--nl-focus-ink', '#ffffff')
  useWritingCanvasStyles(frame.window)
  const dispose = effects[0]()
  t.after(dispose)
  values.set('--nl-border', '#bbbbbb')
  frame.window.dispatchEvent(new frame.window.Event('resize'))
  assert.equal(root.style.getPropertyValue('--nl-border'), '#bbbbbb')
  assert.equal(root.style.getPropertyValue('--nl-focus-page'), '#203040')
  assert.equal(root.style.getPropertyValue('--nl-focus-ink'), '#ffffff')
})

for (const inlinePadding of [0, 200]) {
  test(`page zoom preserves room for the unscaled paper with ${inlinePadding}px of editor rail padding`, t => {
    const dom = new JSDOM(`<body class="page-view"><div id="editor-wrapper"><div id="editor" style="padding-left:${inlinePadding}px;padding-right:0px"><section><div class="nv-page"><p>Prose</p></div></section></div></div></body>`,
      { runScripts: 'outside-only', pretendToBeVisual: true })
    t.after(() => dom.window.close())
    const w = dom.window, wrapper = w.document.getElementById('editor-wrapper'), editor = w.document.getElementById('editor')
    w.document.documentElement.style.setProperty('--nl-space-xl', '16px')
    wrapper.getBoundingClientRect = () => ({ width: 800 })
    Object.defineProperties(wrapper, { offsetWidth: { value: 800 }, clientWidth: { value: 800 }, clientHeight: { value: 600 } })
    const paper = editor.querySelector('.nv-page')
    Object.defineProperty(paper, 'offsetWidth', { value: 544 })
    w.ResizeObserver = class { observe() {} }
    w.eval(readFileSync(new URL('../src/renderer/public/editor/writing-zoom.js', import.meta.url), 'utf8'))
    w.setWritingZoom(1.1)
    const unscaledProseWidth = parseFloat(editor.style.width) - inlinePadding
    assert.ok(unscaledProseWidth >= paper.offsetWidth, `zoom shrank the paper's available width to ${unscaledProseWidth}px`)
    assert.equal(editor.style.transform, 'scale(1.1)')
    w.setWritingZoom(1)
    assert.equal(editor.style.width, '')
    assert.equal(editor.style.paddingLeft, `${inlinePadding}px`)
  })
}
