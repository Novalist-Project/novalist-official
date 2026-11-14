import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { buildWritingAppearance } from './fixtures/writingAppearance'

const prose = '<p>English العربية 123.</p><p>مرحبا English 123.</p><p dir="ltr" style="text-align:right">مرحبا explicit</p><div style="text-align:center"><p>وسط عربي</p></div><blockquote style="direction:rtl"><p>English quoted</p></blockquote>'

async function setInterface(page: Page, language: 'ar' | 'en'): Promise<void> {
  await page.evaluate(language => (window as unknown as EditorWindow).setInterfaceLanguage(language, language === 'ar' ? 'rtl' : 'ltr'), language)
}

async function load(page: Page): Promise<void> {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await setInterface(page, 'ar')
  await page.evaluate(prose => {
    const editor = window as unknown as EditorWindow
    editor.setLanguage('de-CH')
    editor.setWritingContext({ workspaceId: 'interface', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'interface')
    editor.setWritingProjection([{ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId: 's', html: prose, hash: '', revision: 0 }], null)
    editor.focusEditor()
  }, prose)
}

test('interface switching preserves mixed prose, authored alignment, proofing language and selection', async ({ page }) => {
  await load(page)
  await page.evaluate(() => (window as unknown as EditorWindow).restoreWritingSelection({
    anchor: { sceneId: 's', offset: 0, affinity: 'after' }, focus: { sceneId: 's', offset: 7, affinity: 'after' }
  }))
  for (const language of ['ar', 'en', 'ar'] as const) {
    await setInterface(page, language)
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(page.locator('#floating-toolbar')).toHaveCSS('direction', language === 'ar' ? 'rtl' : 'ltr')
    await expect(page.locator('#editor')).toHaveAttribute('lang', 'de-CH')
    const paragraphs = page.locator('[data-writing-scene] p')
    await expect(paragraphs.nth(0)).toHaveCSS('direction', 'ltr')
    await expect(paragraphs.nth(1)).toHaveCSS('direction', 'rtl')
    await expect(paragraphs.nth(2)).toHaveCSS('text-align', 'right')
    await expect(paragraphs.nth(2)).toHaveCSS('direction', 'ltr')
    await expect(paragraphs.nth(3)).toHaveCSS('text-align', 'center')
    await expect(paragraphs.nth(4)).toHaveCSS('direction', 'rtl')
    expect(await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('s'))).toBe(prose)
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('English')
  }
})

for (const mode of ['ordinary', 'book', 'page']) for (const zoom of [0.5, 1, 2]) {
  test(`Arabic interface ${mode} at zoom ${zoom} keeps native prose inside its viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 })
    await load(page)
    await page.evaluate(({ mode, zoom }) => {
      const editor = window as unknown as EditorWindow
      editor.setBookWidth(mode === 'book', 576)
      editor.setPageView(mode === 'page')
      editor.setWritingZoom(zoom)
    }, { mode, zoom })
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect.poll(() => page.locator('#editor-wrapper').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1)
    const box = await page.locator('[data-writing-scene] p').first().boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(480)
  })
}

test('Arabic menus and comments follow interface direction and reverse', async ({ page }) => {
  await load(page)
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setWritingServiceScene('s')
    editor.restoreWritingSelection({ anchor: { sceneId: 's', offset: 0, affinity: 'after' }, focus: { sceneId: 's', offset: 7, affinity: 'after' } })
    editor.addCommentToSelection('interface-comment')
    editor.setCommentsData([{ id: 'interface-comment', anchorText: 'English', text: 'English comment' }])
  })
  const card = page.locator('.nv-cc-card').first()
  await expect(card).toBeVisible()
  for (const language of ['ar', 'en'] as const) {
    await setInterface(page, language)
    const text = card.locator('textarea')
    await expect(text).toHaveAttribute('lang', 'de-CH')
    await expect(text).toHaveCSS('direction', 'ltr')
    await expect(card.locator('.nv-cc-anchor')).toHaveCSS('direction', 'ltr')
    await expect(card.locator('.nv-cc-anchor')).toHaveAttribute('lang', 'de-CH')
    await text.fill('تعليق عربي')
    await expect(text).toHaveCSS('direction', 'rtl')
    await text.fill('English comment')
    const gutter = await page.locator('#commentGutter').boundingBox()
    expect(language === 'ar' ? gutter!.x < 5 : gutter!.x > 700).toBe(true)
    const borders = await card.evaluate(element => [getComputedStyle(element).borderLeftWidth, getComputedStyle(element).borderRightWidth])
    expect(parseFloat(borders[language === 'ar' ? 1 : 0])).toBeGreaterThan(parseFloat(borders[language === 'ar' ? 0 : 1]))
    await page.locator('[data-writing-scene] p').first().click({ button: 'right' })
    await expect(page.locator('#context-menu')).toHaveCSS('direction', language === 'ar' ? 'rtl' : 'ltr')
    await expect(page.locator('.cm-shortcut').first()).toHaveCSS('direction', 'ltr')
    await page.keyboard.press('Escape')
  }
  await page.evaluate(() => (window as unknown as EditorWindow).setLanguage('fr'))
  await expect(card.locator('textarea')).toHaveAttribute('lang', 'fr')
  await expect(card.locator('.nv-cc-anchor')).toHaveAttribute('lang', 'fr')
})

test('Arabic mention picker highlights the leading edge without reversing English entity names', async ({ page }) => {
  await load(page)
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.restoreWritingSelection({ anchor: { sceneId: 's', offset: 0, affinity: 'after' }, focus: { sceneId: 's', offset: 0, affinity: 'after' } })
    editor.setMentionCandidates(JSON.stringify([{ primaryName: 'Ada', matchedText: 'Ada', entityId: 'ada', entityType: 'character', isAlias: false }]))
  })
  await page.keyboard.type('@Ad')
  const row = page.locator('.nv-mp-row.selected')
  await expect(row).toContainText('Ada')
  for (const language of ['ar', 'en'] as const) {
    await setInterface(page, language)
    const borders = await row.evaluate(element => [getComputedStyle(element).borderLeftWidth, getComputedStyle(element).borderRightWidth])
    expect(borders).toEqual(language === 'ar' ? ['0px', '2px'] : ['2px', '0px'])
  }
  await page.keyboard.press('Enter')
  await expect(page.locator('.nv-entity-mention')).toHaveText('Ada')
})

test('context submenus stay within both viewport edges in Arabic and English', async ({ page }) => {
  await load(page)
  for (const language of ['ar', 'en'] as const) for (const x of [30, 1370]) {
    await setInterface(page, language)
    await page.mouse.click(x, 100, { button: 'right' })
    const parent = page.locator('#context-menu .cm-parent').first()
    await parent.hover()
    const submenu = parent.locator('.cm-submenu')
    await expect(submenu).toBeVisible()
    const menuBox = await parent.boundingBox()
    const box = await submenu.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440)
    expect(x < 100 ? box!.x >= menuBox!.x + menuBox!.width : box!.x + box!.width <= menuBox!.x).toBe(true)
    await page.keyboard.press('Escape')
  }
})

for (const kind of ['manuscript', 'narration']) {
  test(`${kind} interface language stays independent from mixed book prose`, async ({ page }) => {
    await page.goto(pathToFileURL(resolve(`src/renderer/public/editor/${kind}-editor.html`)).href)
    await setInterface(page, 'ar')
    await page.evaluate(({ kind, prose }) => {
      const frame = window as unknown as { setLanguage(language: string): void; setManuscript(json: string): void; setBook(json: string): void }
      frame.setLanguage('de-CH')
      const scene = { sceneId: 's', chapterGuid: 'c', html: prose, title: 'Scene', wordCount: 7 }
      if (kind === 'manuscript') frame.setManuscript(JSON.stringify([{ chapterGuid: 'c', chapterTitle: 'Chapter', scenes: [scene] }]))
      else frame.setBook(JSON.stringify({ chapters: [{ guid: 'c', title: 'Chapter', scenes: [{ ...scene, sceneTitle: 'Scene' }] }] }))
    }, { kind, prose })
    const surface = page.locator(kind === 'manuscript' ? '.scene-editor' : '.nl-prose')
    for (const language of ['ar', 'en'] as const) {
      await setInterface(page, language)
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await expect(surface).toHaveAttribute('lang', 'de-CH')
      await expect(surface.locator('p').nth(0)).toHaveCSS('direction', 'ltr')
      await expect(surface.locator('p').nth(1)).toHaveCSS('direction', 'rtl')
      await expect(surface.locator('p').nth(2)).toHaveCSS('text-align', 'right')
      await expect(surface.locator('p').nth(4)).toHaveCSS('direction', 'rtl')
    }
  })
}

test('unified scene rail mirrors with interface direction while book width and zoom stay within the pane', async ({ page }) => {
  await page.goto(await buildWritingAppearance())
  const canvas = page.frameLocator('iframe')
  const rail = canvas.locator('.writing-scene-margin').first()
  await expect(rail).toBeVisible()
  for (const language of ['ar', 'en'] as const) for (const zoom of [0.5, 1, 2]) {
    await page.evaluate(language => (window as unknown as { changeLanguage(language: string): Promise<unknown> }).changeLanguage(language), language)
    await expect(rail).toContainText(language === 'ar' ? 'الملخص' : 'Synopsis')
    await page.locator('iframe').evaluate((element, { language, zoom }) => {
      const editor = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      editor.setLanguage('de-CH')
      editor.setInterfaceLanguage(language, language === 'ar' ? 'rtl' : 'ltr')
      editor.setBookWidth(true, 576)
      editor.setWritingZoom(zoom)
    }, { language, zoom })
    await expect(canvas.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    expect(await rail.evaluate(element => element.closest('[lang]')?.getAttribute('lang'))).toBe(language)
    const scene = await canvas.locator('.writing-scene').first().boundingBox()
    const margin = await rail.boundingBox()
    const frame = await page.locator('iframe').boundingBox()
    expect(language === 'ar' ? margin!.x >= scene!.x + scene!.width : margin!.x + margin!.width <= scene!.x).toBe(true)
    expect(margin!.x).toBeGreaterThanOrEqual(frame!.x)
    expect(margin!.x + margin!.width).toBeLessThanOrEqual(frame!.x + frame!.width)
    await expect(canvas.locator('.writing-scene p').first()).toHaveCSS('direction', 'ltr')
    expect(await canvas.locator('#editor-wrapper').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1)
  }
})

test('alignment buttons put each icon on the side it aligns to in both interface directions', async ({ page }) => {
  await page.goto(await buildWritingAppearance())
  const commands = page.locator('.editor-toolbar [data-command^="paragraph.align"]')
  await expect(commands.first()).toBeVisible()
  const change = (language: string): Promise<unknown> => page.evaluate(language => (window as unknown as { changeLanguage(language: string): Promise<unknown> }).changeLanguage(language), language)
  for (const [language, order] of [
    ['en', ['alignLeft', 'alignCenter', 'alignRight', 'alignJustify']],
    ['ar', ['alignRight', 'alignCenter', 'alignLeft', 'alignJustify']],
    ['de', ['alignLeft', 'alignCenter', 'alignRight', 'alignJustify']]
  ] as const) {
    await change(language)
    await expect.poll(() => commands.evaluateAll(buttons => buttons.map(button => button.getAttribute('data-command')!.replace('paragraph.', '')))).toEqual(order)
  }
  await change('ar')
  await page.evaluate(() => { document.documentElement.dir = 'rtl' })
  const [right, left] = await Promise.all([commands.nth(0).boundingBox(), commands.nth(2).boundingBox()])
  expect(right!.x).toBeGreaterThan(left!.x)
  await page.locator('.editor-toolbar-primary').screenshot({ path: 'out/issue78/editor/toolbar-arabic.png' })
})

for (const kind of ['manuscript', 'narration']) {
  test(`${kind} editor gives an empty paragraph the preceding script`, async ({ page }) => {
    await page.goto(pathToFileURL(resolve(`src/renderer/public/editor/${kind}-editor.html`)).href)
    await setInterface(page, 'en')
    const empty = '<p>مرحبا</p><p><br></p>'
    await page.evaluate(({ kind, empty }) => {
      const frame = window as unknown as { setManuscript(json: string): void; setBook(json: string): void }
      const scene = { sceneId: 's', chapterGuid: 'c', html: empty, title: 'Scene', wordCount: 1 }
      if (kind === 'manuscript') frame.setManuscript(JSON.stringify([{ chapterGuid: 'c', chapterTitle: 'Chapter', scenes: [scene] }]))
      else frame.setBook(JSON.stringify({ chapters: [{ guid: 'c', title: 'Chapter', scenes: [{ ...scene, sceneTitle: 'Scene' }] }] }))
    }, { kind, empty })
    await expect(page.locator(kind === 'manuscript' ? '.scene-editor p' : '.nl-prose p').last()).toHaveCSS('direction', 'rtl')
  })
}
