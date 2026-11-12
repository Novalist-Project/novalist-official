import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

type ScrollEditor = EditorWindow & {
  recenterCaret(): void
  NovalistEditorState: { isFocusing: boolean; pageViewRepaginateScheduled: boolean }
  messages: { type: string; word?: string }[]
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(async () => {
    const editor = window as unknown as ScrollEditor
    await document.fonts.ready
    editor.messages = []
    Object.assign(window, { invokeCSharpAction: (json: string) => editor.messages.push(JSON.parse(json)) })
    editor.setContent('<p>The Aelthorn banner burned.</p>')
    editor.setPageView(true)
    document.getElementById('editor')!.focus({ preventScroll: true })
    window.getSelection()!.setPosition(document.querySelector('#editor p')!.firstChild!, 10)
  })
  await expect.poll(() => page.evaluate(() => {
    const state = (window as unknown as ScrollEditor).NovalistEditorState
    return state.isFocusing || state.pageViewRepaginateScheduled
  })).toBe(false)
  await page.evaluate(async () => {
    document.getElementById('editor-wrapper')!.scrollTop = 100
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
})

for (const source of ['caret', 'zoom'] as const) {
  test(`a delayed ${source} scroll leaves the dictionary action clickable`, async ({ page }) => {
    const scroll = await page.evaluate(async source => {
      const editor = window as unknown as ScrollEditor
      const wrapper = document.getElementById('editor-wrapper')!
      const before = wrapper.scrollTop
      if (source === 'caret') editor.recenterCaret()
      else editor.setWritingZoom(1.5)
      const after = wrapper.scrollTop
      // Hold the renderer beyond the former 150 ms suppression deadline,
      // then open the menu before its queued scroll event can be delivered.
      const started = performance.now()
      while (performance.now() - started < 220) { /* Deliberately delay event delivery. */ }
      const paragraph = document.querySelector('#editor p')!
      const rect = paragraph.getBoundingClientRect()
      paragraph.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: rect.left + 30, clientY: rect.top + rect.height / 2
      }))
      editor.setSpellingSuggestions('Aelthorn', ['Althorn'])
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      return { before, after }
    }, source)
    expect(scroll.after).not.toBe(scroll.before)
    await expect(page.locator('#context-menu')).toHaveClass('visible')
    await page.locator('[data-action="addToDictionary"]').click()
    expect(await page.evaluate(() => (window as unknown as ScrollEditor).messages))
      .toContainEqual({ type: 'addToDictionary', word: 'Aelthorn' })
  })
}
