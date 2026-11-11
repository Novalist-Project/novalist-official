import { expect, test } from '@playwright/test'
import { buildRtlContent } from './fixtures/rtlContent'

let url: string
test.beforeAll(async () => { url = await buildRtlContent() })
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error })
  await page.goto(url)
})

test('real fields and changed enum values follow their own content direction', async ({ page }) => {
  const name = page.getByRole('textbox', { name: 'Scene name', exact: true })
  await expect(name).toHaveCSS('direction', 'rtl')
  await name.fill('English 123')
  await expect(name).toHaveCSS('direction', 'ltr')
  await name.fill('ليلى 123')
  await name.press('End')
  await name.press('!')
  await expect(name).toHaveValue('ليلى 123!')
  const select = page.getByRole('combobox', { name: 'Language' })
  await expect(select).toHaveCSS('direction', 'ltr')
  await select.selectOption('العربية')
  await expect(select).toHaveCSS('direction', 'rtl')
  await select.selectOption('English')
  await expect(select).toHaveCSS('direction', 'ltr')
  await expect(page.locator('header').first()).toHaveCSS('direction', 'ltr')
})

test('Markdown uses independent line direction and preserves native typed selection', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Mixed Markdown' })
  await expect(editor.locator('.cm-line').first()).toHaveCSS('direction', 'rtl')
  await expect(editor.locator('.cm-line').nth(1)).toHaveCSS('direction', 'ltr')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' 123')
  await expect(editor).toContainText('English paragraph 123')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.insertText('X')
  await expect(editor).toContainText('English paragraph 12X')
  await page.keyboard.press('Control+Home')
  await page.keyboard.insertText('أهلا ')
  await expect(editor.locator('.cm-line').first()).toHaveText('أهلا مرحبا بالعالم')
  await expect(editor.locator('.cm-line').first()).toHaveCSS('direction', 'rtl')
})

test('Wiki keeps mixed paragraphs independent, Arabic letters joined and code LTR', async ({ page }) => {
  await expect(page.locator('.wiki-article h1')).toHaveCSS('direction', 'rtl')
  await expect(page.locator('.wiki-prose p').first()).toHaveCSS('direction', 'rtl')
  await expect(page.locator('.wiki-prose p').nth(1)).toHaveCSS('direction', 'ltr')
  await expect(page.locator('.wiki-infobox dd')).toHaveCSS('direction', 'rtl')
  await expect(page.locator('.wiki-prose code')).toHaveCSS('direction', 'ltr')
  await expect(page.locator('.wiki-prose blockquote')).toHaveCSS('direction', 'rtl')
  await expect(page.locator('.wiki-prose ul')).toHaveCSS('direction', 'rtl')
  expect(await page.locator('.wiki-lead').evaluate(element => getComputedStyle(element, '::first-letter').float)).toBe('none')
  await expect(page.locator('.wiki-article-header')).toHaveCSS('direction', 'ltr')
})

test('Wiki loose and nested lists and quotations retain Arabic markers without changing table alignment', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { rtlWikiContent: '- عنصر عربي\n\n  فقرة أخرى\n\n  - عنصر داخلي\n\n    فقرة داخلية\n\n> > اقتباس داخلي\n\n| عنوان | آخر |\n| :---: | ---: |\n| عربي | قيمة |' }))
  await page.reload()
  for (const block of await page.locator('.wiki-prose ul,.wiki-prose li,.wiki-prose blockquote').all()) await expect(block).toHaveCSS('direction', 'rtl')
  await expect(page.locator('.wiki-prose th').first()).toHaveCSS('text-align', 'center')
  await expect(page.locator('.wiki-prose td').last()).toHaveCSS('text-align', 'right')
  await page.getByRole('button', { name: 'English Wiki content' }).click()
  for (const block of await page.locator('.wiki-prose ul,.wiki-prose li,.wiki-prose blockquote').all()) await expect(block).toHaveCSS('direction', 'ltr')
})
