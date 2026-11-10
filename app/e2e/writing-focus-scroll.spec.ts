import { expect, test } from '@playwright/test'
import { launchWriting, type WritingHarness } from './fixtures/writingHarness'
import { snapshotWriting } from './fixtures/writingLayoutSnapshot'
import { writingProvenance } from './fixtures/writingProvenance'
import { writeFile } from 'node:fs/promises'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { installPresentationProbe } from './fixtures/writingPresentationProbe'

interface ViewEditor extends EditorWindow { recenterCaret(): void }

const book = { wordCount: 2500, scenes: [
  { id: 'start', html: '<p>alpha <span class="nv-comment" data-comment-id="note">annotation</span></p>' },
  { id: 'long', html: Array.from({ length: 90 }, () => '<p>long synthetic paragraph with enough words to span several pages.</p>').join('') },
  { id: 'distant', html: '<p>distant synthetic paragraph</p>' },
  { id: 'empty', html: '<p><br></p>' }
] }

async function viewport(h: WritingHarness, pane: number, flush = false) {
  return h.frames()[pane].evaluate(flush => {
    if (flush) (window as unknown as ViewEditor).flushPendingContentChange()
    const wrapper = document.getElementById('editor-wrapper')!
    const selection = getSelection()!
    const range = document.createRange()
    range.setStart(selection.focusNode!, selection.focusOffset)
    range.collapse(true)
    let rect = range.getBoundingClientRect()
    if (!rect.height) rect = (selection.focusNode!.nodeType === Node.ELEMENT_NODE
      ? selection.focusNode as Element : selection.focusNode!.parentElement!).getBoundingClientRect()
    const view = wrapper.getBoundingClientRect()
    return { scrollTop: wrapper.scrollTop, scrollHeight: wrapper.scrollHeight, top: rect.top, bottom: rect.bottom,
      viewportTop: view.top, viewportBottom: view.bottom, visible: rect.bottom >= view.top && rect.top <= view.bottom }
  }, flush)
}

async function reveal(h: WritingHarness, pane: number, scene: number, offset = 8) {
  return h.page.evaluate(({ pane, scene, offset }) => {
    window.writingPanes[pane].select({ scene, offset }, { scene, offset })
    const editor = document.querySelectorAll('iframe')[pane].contentWindow as ViewEditor
    editor.recenterCaret()
    const wrapper = editor.document.getElementById('editor-wrapper')!
    const rect = editor.getSelection()!.getRangeAt(0).getBoundingClientRect()
    const view = wrapper.getBoundingClientRect()
    return { scrollTop: wrapper.scrollTop, top: rect.top, bottom: rect.bottom, visible: rect.bottom >= view.top && rect.top <= view.bottom }
  }, { pane, scene, offset })
}

async function setup(mode = 'normal') {
  const h = await launchWriting('experiment', 2, false)
  await h.seed(book)
  await h.page.evaluate(installPresentationProbe)
  await h.page.evaluate(mode => {
    for (const frame of document.querySelectorAll('iframe')) {
      const editor = frame.contentWindow as ViewEditor
      editor.setPageView(mode.includes('page'))
      editor.setTypewriterScroll(mode.includes('typewriter'), 'middle')
    }
  }, mode)
  await h.page.waitForTimeout(220)
  return h
}

for (const mode of ['normal', 'page', 'typewriter', 'page-typewriter']) {
test(`focus viewport: explicit reveal survives the previous native focus return in ${mode}`, async ({}, info) => {
  const h = await setup(mode)
  try {
    await reveal(h, 0, 0)
    await h.page.waitForTimeout(130)
    const requested = await reveal(h, 1, 2)
    await h.page.waitForTimeout(130)
    const performed = await viewport(h, 1)
    await writeFile(info.outputPath('viewport-evidence.json'), JSON.stringify({ provenance: writingProvenance(), requested, performed }, null, 2))
    expect(requested.visible).toBe(true)
    expect(performed.scrollTop).toBeCloseTo(requested.scrollTop, 0)
    expect(performed.visible).toBe(true)
    const snapshot = await snapshotWriting(h.page)
    expect(snapshot.panes[1].selection.focus).toEqual({ sceneId: 'distant', offset: 8 })
    expect(snapshot.panes[0].undoGroups).toEqual([])
    expect(snapshot.publications).toEqual([])
    expect(await h.page.evaluate(() => ({ captures: window.writingWork.captures, transactions: window.writingWork.transactions }))).toEqual({ captures: 0, transactions: 0 })
  } finally { await h.close() }
})
}

test('focus viewport: native return preserves an intentionally scrolled-away view through overlapping returns', async ({}, info) => {
  const h = await setup()
  try {
    await reveal(h, 1, 2)
    await h.frames()[1].evaluate(() => { document.getElementById('editor-wrapper')!.scrollTop = 500 })
    await h.page.waitForTimeout(30)
    await reveal(h, 0, 0)
    const checkpoints = await h.page.evaluate(async () => {
      const editors = Array.from(document.querySelectorAll('iframe'), frame => frame.contentWindow as ViewEditor)
      const state = editors[1] as unknown as { NovalistEditorState: { isFocusing: boolean } }
      const wrapper = editors[1].document.getElementById('editor-wrapper')!
      editors[1].document.getElementById('editor')!.focus()
      const first = wrapper.scrollTop
      await new Promise(resolve => setTimeout(resolve, 60))
      editors[0].document.getElementById('editor')!.focus()
      editors[1].document.getElementById('editor')!.focus()
      await new Promise(resolve => setTimeout(resolve, 55))
      const overlapping = { scrollTop: wrapper.scrollTop, focusing: state.NovalistEditorState.isFocusing }
      await new Promise(resolve => setTimeout(resolve, 65))
      return { first, overlapping, final: { scrollTop: wrapper.scrollTop, focusing: state.NovalistEditorState.isFocusing } }
    })
    await writeFile(info.outputPath('return-evidence.json'), JSON.stringify(checkpoints, null, 2))
    expect(checkpoints).toEqual({ first: 500, overlapping: { scrollTop: 500, focusing: true }, final: { scrollTop: 500, focusing: false } })
    expect((await viewport(h, 1)).visible).toBe(false)
    expect((await snapshotWriting(h.page)).publications).toEqual([])
  } finally { await h.close() }
})

for (const mode of ['normal', 'page', 'typewriter', 'page-typewriter']) {
test(`focus viewport: rapid alternating edits preserve a scrolled-away peer in ${mode}`, async ({}, info) => {
  const h = await setup(mode)
  try {
    const checkpoints = []
    for (let turn = 0; turn < 4; turn++) {
      const pane = turn % 2
      const scene = turn % 2 === 0 ? 0 : 2
      const requested = await reveal(h, pane, scene)
      await h.page.keyboard.insertText('q')
      const immediate = await viewport(h, pane, true)
      checkpoints.push({ pane, requested, immediate })
      expect(immediate.visible).toBe(true)
    }
    await h.page.mouse.move(1100, 450)
    await h.page.mouse.wheel(0, -10000)
    await reveal(h, 0, 0)
    await h.page.keyboard.insertText('x')
    await viewport(h, 0, true)
    await h.page.waitForTimeout(220)
    const peer = await viewport(h, 1)
    await writeFile(info.outputPath('alternating-evidence.json'), JSON.stringify({ checkpoints, peer }, null, 2))
    expect(peer.scrollTop).toBe(0)
    expect(peer.visible).toBe(false)
    const snapshot = await snapshotWriting(h.page)
    expect(snapshot.panes[0].scenes).toEqual(snapshot.panes[1].scenes)
    expect(snapshot.panes[0].selection.focus).toEqual({ sceneId: 'start', offset: 9 })
    expect(snapshot.panes[1].selection.focus).toEqual({ sceneId: 'distant', offset: 9 })
    expect(snapshot.panes[0].undoGroups).toEqual([[0], [2], [0], [2], [0]])
    expect(snapshot.publications).toEqual([
      { sceneId: 'start', html: '<p>alpha <span class="nv-comment" data-comment-id="note">anqnotation</span></p>' },
      { sceneId: 'distant', html: '<p>distant qsynthetic paragraph</p>' },
      { sceneId: 'start', html: '<p>alpha <span class="nv-comment" data-comment-id="note">anqqnotation</span></p>' },
      { sceneId: 'distant', html: '<p>distant qqsynthetic paragraph</p>' },
      { sceneId: 'start', html: '<p>alpha <span class="nv-comment" data-comment-id="note">anxqqnotation</span></p>' }
    ])
  } finally { await h.close() }
})
}

test('focus viewport: a later backward range and empty scene survive a queued native return', async () => {
  const h = await setup()
  try {
    await reveal(h, 1, 0)
    await reveal(h, 0, 0)
    await h.page.evaluate(() => {
      const editor = document.querySelectorAll('iframe')[1].contentWindow as ViewEditor
      editor.document.getElementById('editor')!.focus()
      window.writingPanes[1].select({ scene: 2, offset: 17 }, { scene: 2, offset: 3 })
      editor.document.querySelector('[data-scene-id="distant"]')!.scrollIntoView({ block: 'center' })
    })
    await h.page.waitForTimeout(130)
    const range = (await snapshotWriting(h.page)).panes[1].selection
    expect(range.anchor).toEqual({ sceneId: 'distant', offset: 17 })
    expect(range.focus).toEqual({ sceneId: 'distant', offset: 3 })
    expect(range.text).toBe('tant synthetic')
    expect((await viewport(h, 1)).visible).toBe(true)
    await reveal(h, 0, 0)
    await reveal(h, 1, 3, 0)
    await h.page.waitForTimeout(130)
    const snapshot = await snapshotWriting(h.page)
    expect(snapshot.panes[1].selection.focus).toEqual({ sceneId: 'empty', offset: 0 })
    expect((await viewport(h, 1)).visible).toBe(true)
    expect(snapshot.publications).toEqual([])
  } finally { await h.close() }
})

test('focus viewport: wheel and keyboard navigation supersede a queued native return', async ({}, info) => {
  const h = await setup('typewriter')
  try {
    await reveal(h, 1, 2)
    await reveal(h, 0, 0)
    await h.page.mouse.move(1100, 450)
    const before = await h.frames()[1].evaluate(() => {
      document.getElementById('editor')!.focus()
      return document.getElementById('editor-wrapper')!.scrollTop
    })
    await h.page.mouse.wheel(0, -900)
    await h.page.waitForTimeout(40)
    const wheel = await viewport(h, 1)
    await h.page.waitForTimeout(100)
    const afterWheel = await viewport(h, 1)
    expect(wheel.scrollTop).toBeLessThan(before)
    expect(afterWheel.scrollTop).toBe(wheel.scrollTop)
    await h.page.mouse.click(1100, 450)
    const pointer = (await snapshotWriting(h.page)).panes[1].selection
    await h.page.waitForTimeout(130)
    expect((await snapshotWriting(h.page)).panes[1].selection).toEqual(pointer)
    await reveal(h, 0, 0)
    await h.frames()[1].evaluate(() => document.getElementById('editor')!.focus())
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await h.page.keyboard.press(`${modifier}+Home`)
    await h.page.waitForTimeout(40)
    const keyboard = await viewport(h, 1)
    await h.page.waitForTimeout(100)
    const afterKeyboard = await viewport(h, 1)
    await writeFile(info.outputPath('gesture-evidence.json'), JSON.stringify({ before, wheel, afterWheel, pointer, keyboard, afterKeyboard }, null, 2))
    expect(afterKeyboard.scrollTop).toBe(keyboard.scrollTop)
    expect(afterKeyboard.visible).toBe(true)
    const snapshot = await snapshotWriting(h.page)
    expect(snapshot.panes[1].selection.focus).toEqual({ sceneId: 'start', offset: 0 })
    expect(snapshot.publications).toEqual([])
  } finally { await h.close() }
})

test('focus viewport: zoom during native composition preserves the pinned owner and deferred scope', async () => {
  const h = await setup()
  try {
    await reveal(h, 0, 0, 5)
    const session = await h.page.context().newCDPSession(h.page)
    await session.send('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 })
    await h.page.evaluate(() => {
      const editor = document.querySelector('iframe')!.contentWindow as ViewEditor
      editor.setWritingZoom(1.1)
      window.writingPanes[0].scope([2, 3])
    })
    await h.page.waitForTimeout(130)
    expect(await h.frames()[0].evaluate(() => document.querySelector<HTMLElement>('[data-scene-id="start"]')!.hidden)).toBe(false)
    await session.send('Input.insertText', { text: '漢字' })
    await expect.poll(() => h.page.evaluate(() => window.writingPanes[0].serialize()[0].text)).toBe('alpha漢字 annotation')
    await expect.poll(() => h.frames()[0].evaluate(() => document.querySelector<HTMLElement>('[data-scene-id="start"]')!.hidden)).toBe(true)
    await h.frames()[0].evaluate(() => (window as unknown as ViewEditor).flushPendingContentChange())
    await expect.poll(() => h.page.evaluate(() => window.writingPublications)).toEqual([{ sceneId: 'start', html: '<p>alpha漢字 <span class="nv-comment" data-comment-id="note">annotation</span></p>' }])
    const snapshot = await snapshotWriting(h.page)
    expect(snapshot.panes[0].scenes).toEqual(snapshot.panes[1].scenes)
    expect(snapshot.panes[0].undoGroups).toEqual([[0]])
    expect(snapshot.panes[0].owners.every(owner => owner.connected)).toBe(true)
    await session.detach()
  } finally { await h.close() }
})

test('focus viewport: scope retains one owner and disposal cancels pending native restores', async () => {
  const h = await setup()
  try {
    await reveal(h, 1, 2)
    await reveal(h, 0, 0)
    const sameOwner = await h.page.evaluate(() => {
      const editor = document.querySelectorAll('iframe')[1].contentWindow!
      const viewport = editor.writingViewport!
      for (let round = 0; round < 8; round++) {
        window.writingPanes[1].scope([2, 3])
        window.writingPanes[1].scope([0, 1, 2, 3])
      }
      editor.document.getElementById('editor')!.focus()
      viewport.dispose()
      editor.document.getElementById('editor-wrapper')!.scrollTop = 400
      return viewport === editor.writingViewport
    })
    await h.page.waitForTimeout(130)
    expect(sameOwner).toBe(true)
    expect((await viewport(h, 1)).scrollTop).toBe(400)
    expect((await snapshotWriting(h.page)).publications).toEqual([])
  } finally { await h.close() }
})
