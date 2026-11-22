import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

async function caret(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection()!
    const range = selection.getRangeAt(0)
    let rect = range.getBoundingClientRect()
    const paragraph = (selection.focusNode!.nodeType === Node.ELEMENT_NODE
      ? selection.focusNode as Element : selection.focusNode!.parentElement!).closest('p')!
    if (!rect.height) rect = paragraph.getBoundingClientRect()
    const wrapper = document.getElementById('editor-wrapper')!
    return { top: rect.top - wrapper.getBoundingClientRect().top,
      bottom: rect.bottom - wrapper.getBoundingClientRect().top,
      height: wrapper.clientHeight, id: paragraph.id }
  })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(async () => {
    await document.fonts.ready
    const editor = window as unknown as EditorWindow
    editor.setContent(Array.from({ length: 60 }, (_, index) => `<p id="line-${index}">${index === 0 || index === 59 ? "A line of prose." : "<br>"}</p>`).join(''))
    document.getElementById('editor')!.focus()
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { NovalistEditorState: { isFocusing: boolean } }).NovalistEditorState.isFocusing)).toBe(false)
  await page.evaluate(() => window.getSelection()!.setPosition(document.getElementById('line-20')!, 0))
})

test('every arrow step keeps an empty line at the typewriter anchor', async ({ page }) => {
  await page.evaluate(() => (window as unknown as EditorWindow).setTypewriterScroll(true, 'middle'))
  await expect.poll(async () => Math.abs((await caret(page)).top - 300)).toBeLessThan(2)
  for (let line = 21; line <= 25; line++) {
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await caret(page)).id).toBe(`line-${line}`)
    await expect.poll(async () => Math.abs((await caret(page)).top - 300)).toBeLessThan(2)
  }
})

for (const typewriter of [false, true]) {
  test(`arrow navigation resumes following an empty line after wheel scrolling, typewriter=${typewriter}`, async ({ page }) => {
    await page.evaluate((enabled) => {
      const editor = window as unknown as EditorWindow
      editor.setTypewriterScroll(enabled, 'middle')
      const wrapper = document.getElementById('editor-wrapper')!
      wrapper.scrollTop += document.getElementById('line-20')!.getBoundingClientRect().top - 300
    }, typewriter)
    await expect.poll(async () => Math.abs((await caret(page)).top - 300)).toBeLessThan(2)
    await page.mouse.move(450, 300)
    await page.mouse.wheel(0, 500)
    await expect.poll(async () => (await caret(page)).top).toBeLessThan(0)
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await caret(page)).id).toBe('line-21')
    if (typewriter) {
      await expect.poll(async () => Math.abs((await caret(page)).top - 300)).toBeLessThan(2)
    } else {
      await expect.poll(async () => (await caret(page)).top).toBeGreaterThanOrEqual(39)
      const position = await caret(page)
      expect(position.bottom).toBeLessThanOrEqual(position.height - 39)
    }
  })
}

for (const pages of [false, true]) {
  for (const key of ['Enter', 'Shift+Enter']) {
    test(`${key} preserves paragraph semantics and the visible caret, pages=${pages}`, async ({ page }) => {
      const index = await page.evaluate(pages => {
        const editor = window as unknown as EditorWindow
        document.body.classList.add('unified-writing-canvas')
        editor.setWritingContext({ workspaceId: 'paragraph-test', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'pane')
        editor.setWritingProjection([{ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId: 's', revision: 0, hash: 'h',
          html: Array.from({ length: 70 }, (_, i) => `<p>Paragraph ${i} with some writing.</p>`).join('') }], null)
        editor.setBookWidth(true, 500)
        editor.setPageView(pages)
        const root = editor.getWritingSceneRoot('s')!
        const paragraphs = [...root.querySelectorAll('p')]
        const paragraph = pages ? root.querySelector('.nv-page')!.lastElementChild! : paragraphs[20]
        const text = paragraph.firstChild!
        window.getSelection()!.setBaseAndExtent(text, text.textContent!.length, text, text.textContent!.length)
        const wrapper = document.getElementById('editor-wrapper')!
        wrapper.scrollTop += paragraph.getBoundingClientRect().bottom - wrapper.getBoundingClientRect().bottom + 40
        return paragraphs.indexOf(paragraph as HTMLParagraphElement)
      }, pages)
      await page.keyboard.press(key)
      // Cross the layout debounce while the new paragraph or line is empty.
      await page.waitForTimeout(250)
      const emptyPosition = await caret(page)
      expect(emptyPosition.top).toBeGreaterThanOrEqual(39)
      expect(emptyPosition.bottom).toBeLessThanOrEqual(emptyPosition.height - 39)
      await page.keyboard.insertText('Continued writing')
      // Cross the layout debounce to catch a caret moved offscreen after input.
      await page.waitForTimeout(250)
      const result = await page.evaluate(({ index, key }) => {
        const paragraphs = [...document.querySelectorAll('[data-writing-scene="s"] p')]
        const selection = window.getSelection()!
        const element = selection.focusNode!.nodeType === Node.ELEMENT_NODE
          ? selection.focusNode as Element : selection.focusNode!.parentElement!
        const expected = paragraphs[index + (key === 'Enter' ? 1 : 0)]
        return { count: paragraphs.length, correctParagraph: element.closest('p') === expected,
          text: (expected as HTMLElement).innerText }
      }, { index, key })
      expect(result.count).toBe(key === 'Enter' ? 71 : 70)
      expect(result.correctParagraph).toBe(true)
      expect(result.text).toBe(key === 'Enter' ? 'Continued writing' : `Paragraph ${index} with some writing.\nContinued writing`)
      const position = await caret(page)
      expect(position.top).toBeGreaterThanOrEqual(39)
      expect(position.bottom).toBeLessThanOrEqual(position.height - 39)
    })
  }
}

for (const typewriter of [false, true]) {
  for (const zoom of [1, 1.5]) {
    test(`arrow navigation follows an empty first line onto the next book page, typewriter=${typewriter}, zoom=${zoom}`, async ({ page }) => {
      const nextId = await page.evaluate(({ enabled, zoom }) => {
        const editor = window as unknown as EditorWindow
        editor.setPageView(true)
        editor.setWritingZoom(zoom)
        const pages = document.querySelectorAll('.nv-page')
        const previous = pages[0].lastElementChild!
        window.getSelection()!.setPosition(previous, 0)
        editor.setTypewriterScroll(enabled, 'middle')
        const wrapper = document.getElementById('editor-wrapper')!
        wrapper.scrollTop += previous.getBoundingClientRect().top - (enabled ? 300 : 500)
        return pages[1].firstElementChild!.id
      }, { enabled: typewriter, zoom })
      for (let step = 0; step < 4; step++) {
        await page.keyboard.press('ArrowDown')
        await expect.poll(async () => (await caret(page)).id).toBe(`line-${Number(nextId.slice(5)) + step}`)
        if (typewriter) {
          await expect.poll(async () => Math.abs((await caret(page)).top - 300)).toBeLessThan(2)
        } else {
          await expect.poll(async () => (await caret(page)).bottom).toBeLessThanOrEqual(561)
          expect((await caret(page)).top).toBeGreaterThanOrEqual(39)
        }
      }
    })
  }
}
