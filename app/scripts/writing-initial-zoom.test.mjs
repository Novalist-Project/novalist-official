import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'
import { loadRendererSource } from './renderer-source-loader.mjs'

async function fixture(t) {
  const dom = new JSDOM('<div id="host"></div><iframe></iframe>', { url: 'https://fixture.invalid/' })
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const settings = create(() => ({ view: null }))
  const { useWritingZoomStore: zoom } = loadRendererSource('src/stores/writingZoomStore.ts', { zustand: { create } })
  const typography = loadRendererSource('src/views/editor/writingTypography.ts', {
    '../../stores/writingZoomStore': { useWritingZoomStore: zoom }, '../settings/settingsTypography': { PAGE_FORMAT_WIDTHS: {} }
  })
  const { useWritingInitialZoom } = loadRendererSource('src/views/editor/useWritingInitialZoom.ts', {
    react: React, '../../stores/settingsStore': { useSettingsStore: settings },
    '../../stores/writingZoomStore': { useWritingZoomStore: zoom }, './writingTypography': typography
  }, { MutationObserver: dom.window.MutationObserver })
  const frame = dom.window.document.querySelector('iframe'), live = frame.contentWindow, frames = []
  let fontsReady
  Object.defineProperty(live.document, 'fonts', { value: { ready: new Promise(resolve => { fontsReady = resolve }) } })
  live.requestAnimationFrame = callback => frames.push(callback)
  live.getWritingZoomToFit = () => 1.337
  live.repaginatePageView = () => {}
  const root = createRoot(dom.window.document.getElementById('host'))
  function Probe({ revision }) { useWritingInitialZoom(live, revision); return null }
  const render = revision => React.act(async () => root.render(React.createElement(Probe, { revision })))
  const settle = () => React.act(async () => {
    fontsReady()
    await Promise.resolve()
    while (frames.length) frames.shift()(0)
  })
  t.after(async () => {
    try { await React.act(() => root.unmount()) }
    finally { dom.window.close(); Object.assign(globalThis, previous) }
  })
  await render(0)
  return { frame, live, zoom, settings, render, settle,
    load: () => { live.document.body.innerHTML = '<section data-writing-scene="scene"><p>Ready prose</p></section>' } }
}

test('writing opens at a readable text scale after settings and prose are ready', async t => {
  const f = await fixture(t)
  await f.settle()
  assert.equal(f.zoom.getState().initialized, false)
  f.load()
  await f.render(1)
  await f.settle()
  assert.equal(f.zoom.getState().initialized, false)
  await React.act(() => f.settings.setState({ view: { effective: { editorFontSize: 17 } } }))
  await f.settle()
  assert.equal(f.zoom.getState().percent, 130)
  assert.equal(f.zoom.getState().initialized, true)
  f.live.getWritingZoomToFit = () => 2
  await f.render(2)
  await f.settle()
  assert.equal(f.zoom.getState().percent, 130, 'later projections retain the chosen scale')
})

test('a manual wheel choice while fonts settle wins over the delayed initial fit', async t => {
  const f = await fixture(t)
  f.load()
  await React.act(() => f.settings.setState({ view: { effective: { editorFontSize: 17 } } }))
  await f.render(1)
  f.zoom.getState().change(-1)
  await f.settle()
  assert.equal(f.zoom.getState().percent, 90)
})

test('an empty projection or detached iframe cannot consume the first fit', async t => {
  const f = await fixture(t)
  await React.act(() => f.settings.setState({ view: { effective: { editorFontSize: 17 } } }))
  await f.render(1)
  await f.settle()
  assert.equal(f.zoom.getState().initialized, false)
  f.load()
  await f.render(2)
  f.frame.remove()
  await f.settle()
  assert.equal(f.zoom.getState().initialized, false)
})

test('initial paper fit waits for the actual page layout before consuming the first zoom', async t => {
  const f = await fixture(t)
  f.load()
  f.live.document.body.classList.add('page-view')
  f.live.getWritingZoomToFit = () => f.live.document.querySelector('.nv-page') ? 1.23 : 1
  await React.act(() => f.settings.setState({ view: { effective: { editorFontSize: 17, pageViewEnabled: true } } }))
  await f.render(1)
  await f.settle()
  assert.equal(f.zoom.getState().initialized, false)
  await React.act(() => {
    const scene = f.live.document.querySelector('[data-writing-scene]')
    const paper = f.live.document.createElement('div')
    paper.className = 'nv-page'
    paper.append(...scene.childNodes)
    scene.append(paper)
  })
  assert.equal(f.zoom.getState().percent, 130)
})

test('a large configured writing font starts at 100 percent', async t => {
  const f = await fixture(t)
  f.load()
  await React.act(() => f.settings.setState({ view: { effective: { editorFontSize: 28 } } }))
  await f.render(1)
  await f.settle()
  assert.equal(f.zoom.getState().percent, 100)
})

test('book typography starts at its paper fit rather than the unrelated editor font size', async t => {
  const f = await fixture(t)
  f.load()
  f.live.document.body.classList.add('page-view')
  f.live.document.querySelector('[data-writing-scene]').innerHTML = '<div class="nv-page"><p>Book prose</p></div>'
  f.live.getWritingZoomToFit = () => 3.2
  await React.act(() => f.settings.setState({ view: { effective: { editorFontSize: 29, bookFontSize: 11, enableBookWidth: true, pageViewEnabled: true } } }))
  await f.render(1)
  await f.settle()
  assert.equal(f.zoom.getState().percent, 300)
  assert.equal(f.zoom.getState().initialized, true)
})
