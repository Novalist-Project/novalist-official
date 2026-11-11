import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

const html = '<p>مرحبا بالعالم English 123.</p><p>English العربية 123.</p><p dir="ltr" style="text-align:right">مرحبا explicit</p>'
async function load(page: Page, content = html): Promise<void> {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
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
    expect(await page.locator('#editor-wrapper').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1)
    await expect(page.locator('[data-writing-scene] p').first()).toHaveCSS('direction', 'rtl')
    await expect(page.locator('[data-writing-scene] p').last()).toHaveCSS('direction', 'ltr')
  })
}
