import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

const html = '<p>مرحبا بالعالم English 123.</p><p>English العربية 123.</p><p dir="ltr" style="text-align:right">مرحبا explicit</p>'
async function setInterfaceDirection(page: Page, direction: 'ltr' | 'rtl'): Promise<void> {
  await page.evaluate(direction => (window as unknown as EditorWindow).setInterfaceLanguage(direction === 'rtl' ? 'ar' : 'en', direction), direction)
}

async function pressEndEnter(page: Page): Promise<void> {
  await page.locator('[data-writing-scene] p').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
}

async function caretOffsetFromParagraphEnd(page: Page): Promise<{ right: number, left: number }> {
  return page.evaluate(() => {
    const range = window.getSelection()!.getRangeAt(0)
    const paragraph = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement!).closest('p')!
    const marker = document.createRange()
    marker.selectNode(paragraph.querySelector('br')!)
    const rect = marker.getBoundingClientRect()
    const box = paragraph.getBoundingClientRect()
    return { right: box.right - rect.right, left: rect.left - box.left }
  })
}

async function load(page: Page, content = html, interfaceDirection: 'ltr' | 'rtl' = 'ltr'): Promise<void> {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await setInterfaceDirection(page, interfaceDirection)
  await page.evaluate(content => {
    const editor = window as unknown as EditorWindow
    editor.setWritingContext({ workspaceId: 'rtl', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'rtl')
    editor.setWritingProjection([{ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId: 's', html: content, hash: '', revision: 0 }], null)
    editor.focusEditor()
  }, content)
}

for (const mode of ['ordinary', 'book', 'page']) for (const zoom of [0.5, 1, 2]) test(`legacy ${mode} RTL zoom ${zoom} keeps prose within the pane`, async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 })
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(({ mode, zoom }) => {
    const editor = window as unknown as EditorWindow
    editor.setContent('<p>' + 'مرحبا بالعالم English 123. '.repeat(40) + '</p>')
    editor.setFont('Arial', 17)
    editor.setBookWidth(mode === 'book', 576)
    editor.setPageView(mode === 'page')
    editor.setWritingZoom(zoom)
  }, { mode, zoom })
  await page.waitForTimeout(100)
  expect(await page.locator('#editor-wrapper').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1)
})
test('native direction, explicit alignment, typing, Enter and selection survive reload', async ({ page }) => {
  await load(page)
  const paragraphs = page.locator('[data-writing-scene] p')
  await expect(paragraphs.nth(0)).toHaveCSS('direction', 'rtl')
  await expect(paragraphs.nth(1)).toHaveCSS('direction', 'ltr')
  await expect(paragraphs.nth(2)).toHaveCSS('direction', 'ltr')
  await expect(paragraphs.nth(2)).toHaveCSS('text-align', 'right')
  await expect(page.locator('#editor')).toHaveCSS('direction', 'ltr')
  await paragraphs.first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('عربية جديدة English')
  await expect(paragraphs.nth(1)).toHaveCSS('direction', 'rtl')
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.restoreWritingSelection({ anchor: { sceneId: 's', offset: 9, affinity: 'after' }, focus: { sceneId: 's', offset: 2, affinity: 'after' } })
  })
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('حبا بال')
  const saved = await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('s'))
  await load(page, saved)
  await expect(paragraphs.nth(1)).toContainText('عربية جديدة English')
  await expect(paragraphs.last()).toHaveAttribute('dir', 'ltr')
  await expect(paragraphs.last()).toHaveCSS('text-align', 'right')
})

test('native paste and list formatting preserve explicit direction and list markers', async ({ page }) => {
  await load(page, '<p><br></p>')
  await page.locator('[data-writing-scene] p').click()
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/html', '<ul dir="rtl"><li>مرحبا English</li><li dir="ltr">English العربية</li></ul><p dir="rtl" style="text-align:center">نهاية</p>')
    document.querySelector('#editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  const list = page.locator('[data-writing-scene] ul')
  await expect(list).toHaveCount(1)
  await expect(list.locator('li').first()).toHaveCSS('direction', 'rtl')
  await expect(list.locator('li').last()).toHaveCSS('direction', 'ltr')
  await expect(list).toHaveCSS('list-style-type', 'disc')
  await expect(page.locator('[data-writing-scene] p').last()).toHaveCSS('text-align', 'center')
  await load(page, '<p>مرحبا بالعالم</p>')
  await page.locator('[data-writing-scene] p').click()
  await page.evaluate(() => (window as unknown as EditorWindow).toggleNumberList())
  await expect(page.locator('[data-writing-scene] ol li')).toHaveCSS('direction', 'rtl')
})

test('Arabic native arrows move the caret visually and extend the selected text', async ({ page }) => {
  await load(page, '<p>مرحبا بالعالم</p>')
  await page.evaluate(() => (window as unknown as EditorWindow).restoreWritingSelection({
    anchor: { sceneId: 's', offset: 0, affinity: 'after' }, focus: { sceneId: 's', offset: 0, affinity: 'after' }
  }))
  await page.keyboard.press('ArrowLeft')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getWritingSelection()?.focus.offset)).toBe(1)
  await page.keyboard.press('Shift+ArrowLeft')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('ر')
  await page.keyboard.insertText('X')
  await expect(page.locator('[data-writing-scene] p')).toHaveText('مXحبا بالعالم')
})

test('loose nested lists and quotes follow Arabic while manual inherited alignment survives', async ({ page }) => {
  await load(page, '<ul dir="auto"><li><p>عنصر عربي</p><ul><li><p>عنصر آخر</p></li></ul></li></ul><blockquote><p>اقتباس</p></blockquote><div style="text-align:center"><p>وسط عربي</p></div><ul dir="rtl"><li>English</li></ul>')
  for (const container of await page.locator('[data-writing-scene] ul,[data-writing-scene] li,[data-writing-scene] blockquote').all()) await expect(container).toHaveCSS('direction', 'rtl')
  await expect(page.locator('[data-writing-scene] div[style] p')).toHaveCSS('text-align', 'center')
  await expect(page.locator('[data-writing-scene] li').last()).toHaveCSS('text-align', 'start')
  await page.locator('[data-writing-scene] ul').first().locator('p').first().evaluate(node => { node.firstChild!.textContent = 'English' })
  await expect(page.locator('[data-writing-scene] ul').first()).toHaveCSS('direction', 'ltr')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getContent())).toContain('<ul dir="auto">')
})

test('runtime direction does not alter saved pristine HTML or explicit direction', async ({ page }) => {
  const original = '<p>مرحبا</p><p dir="auto">English</p><p dir="rtl">English</p>'
  await load(page, original)
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getContent())).toBe(original)
})

test('explicit ancestor CSS direction remains inherited and survives saving', async ({ page }) => {
  const original = '<blockquote style="direction:rtl"><p>English</p></blockquote><ul style="direction:rtl"><li>English</li></ul><blockquote style="direction:ltr"><p>مرحبا</p></blockquote>'
  await load(page, original)
  await expect(page.locator('blockquote p').first()).toHaveCSS('direction', 'rtl')
  await expect(page.locator('ul li')).toHaveCSS('direction', 'rtl')
  await expect(page.locator('blockquote p').last()).toHaveCSS('direction', 'ltr')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getContent())).toBe(original)
})

for (const width of [480, 1200]) for (const mode of ['ordinary', 'book', 'page']) for (const zoom of [0.5, 1, 2]) {
  test(`${mode} Arabic and English reflow at width ${width}, zoom ${zoom}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await load(page, '<p>' + 'مرحبا بالعالم English 123. '.repeat(30) + '</p><p>' + 'English العربية 123. '.repeat(30) + '</p>')
    await page.addStyleTag({ path: resolve('src/renderer/src/styles/tokens.css') })
    await page.addStyleTag({ path: resolve('src/renderer/src/views/editor/writing-canvas.css') })
    await page.evaluate(({ mode, zoom }) => {
      const editor = window as unknown as EditorWindow
      document.body.classList.add('unified-writing-canvas')
      document.body.classList.toggle('writing-narrow', window.innerWidth < 600)
      editor.setFont('Arial', 17)
      editor.setBookWidth(mode === 'book', 576)
      editor.setPageView(mode === 'page')
      editor.setWritingZoom(zoom)
    }, { mode, zoom })
    await page.waitForTimeout(100)
    if (mode === 'page') {
      expect((await page.locator('.nv-page').first().boundingBox())!.width).toBeCloseTo(210 * 96 / 25.4 * zoom, 0)
    } else {
      expect(await page.locator('#editor-wrapper').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1)
    }
    await expect(page.locator('[data-writing-scene] p').first()).toHaveCSS('direction', 'rtl')
    await expect(page.locator('[data-writing-scene] p').last()).toHaveCSS('direction', 'ltr')
  })
}

test('new empty paragraph continues the script of the paragraph before it', async ({ page }) => {
  const paragraphs = page.locator('[data-writing-scene] p')
  await load(page, '<p>مرحبا بالعالم</p>', 'rtl')
  await pressEndEnter(page)
  await expect(paragraphs).toHaveCount(2)
  await expect(paragraphs.last()).toHaveCSS('direction', 'rtl')
  const caret = await caretOffsetFromParagraphEnd(page)
  expect(caret.right).toBeLessThan(caret.left)
  expect(caret.right).toBeLessThanOrEqual(2)
  await page.screenshot({ path: 'out/issue78/editor/arabic-enter-caret.png', caret: 'initial', clip: { x: 0, y: 0, width: 1440, height: 120 } })
  await page.keyboard.insertText('Latin')
  await expect(paragraphs.last()).toHaveCSS('direction', 'ltr')
  for (let index = 0; index < 5; index++) await page.keyboard.press('Backspace')
  await expect(paragraphs.last()).toHaveCSS('direction', 'rtl')
  await page.keyboard.insertText('12')
  await expect(paragraphs.last()).toHaveCSS('direction', 'rtl')
  await page.keyboard.insertText('عربي')
  await expect(paragraphs.last()).toHaveAttribute('dir', 'auto')
  await page.keyboard.press('Enter')
  await expect(paragraphs.last()).toHaveCSS('direction', 'rtl')
  const saved = await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('s'))
  expect(saved).not.toContain('data-nv-auto-direction')
  expect(saved).not.toContain('dir=')
})

test('an empty paragraph follows the previous script, then the interface', async ({ page }) => {
  const paragraphs = page.locator('[data-writing-scene] p')
  await load(page, '<p>English text</p>', 'rtl')
  await pressEndEnter(page)
  await expect(paragraphs.last()).toHaveCSS('direction', 'ltr')
  await load(page, '<p>مرحبا بالعالم</p>', 'ltr')
  await pressEndEnter(page)
  await expect(paragraphs.last()).toHaveCSS('direction', 'rtl')
  await load(page, '<p><br></p>', 'rtl')
  await expect(paragraphs.first()).toHaveCSS('direction', 'rtl')
  await setInterfaceDirection(page, 'ltr')
  await expect(paragraphs.first()).toHaveCSS('direction', 'ltr')
  await setInterfaceDirection(page, 'rtl')
  await expect(paragraphs.first()).toHaveCSS('direction', 'rtl')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('s'))).toBe('<p><br></p>')
})

test('empty headings and list items take a fallback direction and save pristine', async ({ page }) => {
  const original = '<p>مرحبا</p><h2><br></h2><ul><li><br></li></ul>'
  await load(page, original, 'ltr')
  await expect(page.locator('[data-writing-scene] h2')).toHaveCSS('direction', 'rtl')
  await expect(page.locator('[data-writing-scene] li')).toHaveCSS('direction', 'rtl')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('s'))).toBe(original)
})

test('formatting state reports the alignment the writer sees', async ({ page }) => {
  const alignment = (): Promise<string> => page.evaluate(() => (window as unknown as { getFormattingState(): { alignment: string } }).getFormattingState().alignment)
  const original = '<p>مرحبا</p><p>English</p><p dir="rtl" style="text-align:left">مرحبا</p><p style="text-align:center">English</p><p style="text-align:justify">English</p><p dir="rtl" style="text-align:right">مرحبا</p>'
  await load(page, original, 'rtl')
  const paragraphs = page.locator('[data-writing-scene] p')
  const expected = ['right', 'left', 'left', 'center', 'justify', 'right']
  for (const [index, value] of expected.entries()) {
    await paragraphs.nth(index).click()
    expect(await alignment()).toBe(value)
  }
  await paragraphs.nth(1).click()
  await page.evaluate(() => (window as unknown as EditorWindow).alignRight())
  expect(await alignment()).toBe('right')
})

const latinFirst = '<p>AMMAR ذهب إلى العمل</p><p>مرحبا بالعالم</p><p>English text</p>'
type DirectionWindow = EditorWindow & { getFormattingState(): { direction: string, alignment: string } }
const formatting = (page: Page): Promise<{ direction: string, alignment: string }> => page.evaluate(() => (window as unknown as DirectionWindow).getFormattingState())
const setDirection = (page: Page, direction: 'ltr' | 'rtl' | 'auto'): Promise<void> => page.evaluate(direction => (window as unknown as EditorWindow).setParagraphDirection(direction), direction)
const serialize = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('s'))

test('an explicit paragraph direction fixes a Latin-first Arabic paragraph, saves cleanly and survives reload', async ({ page }) => {
  await load(page, latinFirst, 'rtl')
  const paragraphs = page.locator('[data-writing-scene] p')
  await paragraphs.first().click()
  await expect(paragraphs.first()).toHaveCSS('direction', 'ltr')
  expect((await formatting(page)).direction).toBe('ltr')
  await page.screenshot({ path: 'out/issue78/editor/direction-before.png', clip: { x: 0, y: 0, width: 1440, height: 160 } })
  await setDirection(page, 'rtl')
  await expect(paragraphs.first()).toHaveCSS('direction', 'rtl')
  await expect(paragraphs.nth(2)).toHaveCSS('direction', 'ltr')
  expect((await formatting(page)).direction).toBe('rtl')
  await page.screenshot({ path: 'out/issue78/editor/direction-after.png', clip: { x: 0, y: 0, width: 1440, height: 160 } })
  const saved = await serialize(page)
  expect(saved).toContain('<p style="direction: rtl;">AMMAR')
  expect(saved).not.toContain('data-nv-auto-direction')
  expect(saved).not.toContain('dir=')
  expect(saved).not.toContain('text-align')
  await load(page, saved, 'rtl')
  await expect(paragraphs.first()).toHaveCSS('direction', 'rtl')
  expect(await serialize(page)).toBe(saved)
  await paragraphs.first().click()
  await setDirection(page, 'auto')
  await expect(paragraphs.first()).toHaveCSS('direction', 'ltr')
  expect((await formatting(page)).direction).toBe('ltr')
  expect(await serialize(page)).toBe(latinFirst)
})

test('explicit left-to-right overrides an Arabic paragraph and auto hands it back to its content', async ({ page }) => {
  await load(page, latinFirst, 'rtl')
  const paragraphs = page.locator('[data-writing-scene] p')
  await paragraphs.nth(1).click()
  await expect(paragraphs.nth(1)).toHaveCSS('direction', 'rtl')
  await setDirection(page, 'ltr')
  await expect(paragraphs.nth(1)).toHaveCSS('direction', 'ltr')
  expect((await formatting(page)).direction).toBe('ltr')
  expect(await serialize(page)).toContain('<p style="direction: ltr;">مرحبا')
  await setDirection(page, 'auto')
  await expect(paragraphs.nth(1)).toHaveCSS('direction', 'rtl')
  expect(await serialize(page)).toBe(latinFirst)
})

test('a multi-paragraph selection sets every touched paragraph and leaves the rest', async ({ page }) => {
  await load(page, latinFirst + '<p>Another English one</p>', 'rtl')
  const paragraphs = page.locator('[data-writing-scene] p')
  await page.evaluate(() => {
    const ps = document.querySelectorAll('[data-writing-scene] p')
    window.getSelection()!.setBaseAndExtent(ps[0].firstChild!, 2, ps[2].firstChild!, 3)
  })
  await setDirection(page, 'rtl')
  for (const index of [0, 1, 2]) await expect(paragraphs.nth(index)).toHaveCSS('direction', 'rtl')
  await expect(paragraphs.nth(3)).toHaveCSS('direction', 'ltr')
  const saved = await serialize(page)
  expect(saved.match(/direction: rtl/g)).toHaveLength(3)
})

test('direction is independent of alignment', async ({ page }) => {
  await load(page, '<p style="text-align:right">AMMAR ذهب</p><p>AMMAR ذهب</p>', 'rtl')
  const paragraphs = page.locator('[data-writing-scene] p')
  await paragraphs.first().click()
  await setDirection(page, 'rtl')
  await expect(paragraphs.first()).toHaveCSS('text-align', 'right')
  await paragraphs.nth(1).click()
  await expect(paragraphs.nth(1)).toHaveCSS('text-align', 'start')
  await setDirection(page, 'rtl')
  await expect(paragraphs.nth(1)).toHaveCSS('text-align', 'start')
  expect((await formatting(page)).alignment).toBe('right')
  const saved = await serialize(page)
  expect(saved).toContain('text-align: right')
  expect(saved.match(/text-align/g)).toHaveLength(1)
})

test('Enter at the end of an explicitly directed paragraph continues that direction', async ({ page }) => {
  await load(page, '<p>AMMAR ذهب</p>', 'rtl')
  const paragraphs = page.locator('[data-writing-scene] p')
  await paragraphs.first().click()
  await setDirection(page, 'rtl')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(paragraphs).toHaveCount(2)
  await expect(paragraphs.last()).toHaveCSS('direction', 'rtl')
  await page.keyboard.insertText('Latin only')
  await expect(paragraphs.last()).toHaveCSS('direction', 'rtl')
  expect((await formatting(page)).direction).toBe('rtl')
  const saved = await serialize(page)
  expect(saved.match(/direction: rtl/g)).toHaveLength(2)
  expect(saved).not.toContain('data-nv-auto-direction')
})

test('the right-click menu offers all three paragraph directions, including automatic', async ({ page }) => {
  await load(page, latinFirst, 'rtl')
  const paragraphs = page.locator('[data-writing-scene] p')
  const choose = async (direction: string): Promise<void> => {
    await paragraphs.first().click({ button: 'right' })
    await page.locator('#context-menu .cm-parent', { hasText: 'Paragraph direction' }).hover()
    await page.locator(`#context-menu [data-action="paragraphDirection:${direction}"]`).click()
  }
  await choose('rtl')
  await expect(paragraphs.first()).toHaveCSS('direction', 'rtl')
  await choose('ltr')
  await expect(paragraphs.first()).toHaveCSS('direction', 'ltr')
  await choose('rtl')
  await choose('auto')
  await expect(paragraphs.first()).toHaveCSS('direction', 'ltr')
  expect(await serialize(page)).toBe(latinFirst)
})

test('a list given a direction carries it to every item, live and after reload', async ({ page }) => {
  const list = '<p>مرحبا بالعالم</p><ul><li>AMMAR ذهب إلى العمل</li><li>Second item here</li></ul>'
  await load(page, list, 'rtl')
  const items = page.locator('[data-writing-scene] li')
  const markerSide = (): Promise<boolean> => items.first().evaluate(item => {
    const text = document.createRange()
    text.selectNodeContents(item)
    return text.getBoundingClientRect().right > item.getBoundingClientRect().right - 2
  })
  await items.first().click()
  for (const index of [0, 1]) await expect(items.nth(index)).toHaveCSS('direction', 'ltr')
  expect((await formatting(page)).direction).toBe('ltr')
  expect(await markerSide()).toBe(false)
  await setDirection(page, 'rtl')
  for (const index of [0, 1]) await expect(items.nth(index)).toHaveCSS('direction', 'rtl')
  expect((await formatting(page)).direction).toBe('rtl')
  expect(await markerSide()).toBe(true)
  await page.screenshot({ path: 'out/issue78/editor/direction-list-after.png', clip: { x: 0, y: 0, width: 1440, height: 200 } })
  const saved = await serialize(page)
  expect(saved).toBe('<p>مرحبا بالعالم</p><ul style="direction: rtl;"><li>AMMAR ذهب إلى العمل</li><li>Second item here</li></ul>')
  await load(page, saved, 'rtl')
  for (const index of [0, 1]) await expect(items.nth(index)).toHaveCSS('direction', 'rtl')
  expect(await serialize(page)).toBe(saved)
  await items.first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('Third')
  await expect(items).toHaveCount(3)
  await expect(items.nth(1)).toHaveCSS('direction', 'rtl')
  await setDirection(page, 'auto')
  for (const index of [0, 1, 2]) await expect(items.nth(index)).toHaveCSS('direction', 'ltr')
  expect((await formatting(page)).direction).toBe('ltr')
  expect(await serialize(page)).not.toContain('direction')
})

test('the direction state follows the list item the caret is in', async ({ page }) => {
  await load(page, '<ul><li>English item</li><li>عنصر عربي</li></ul>', 'ltr')
  const items = page.locator('[data-writing-scene] li')
  await items.nth(0).click()
  expect((await formatting(page)).direction).toBe('ltr')
  await items.nth(1).click()
  await expect(items.nth(1)).toHaveCSS('direction', 'rtl')
  expect((await formatting(page)).direction).toBe('rtl')
})
