import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
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

test('unchanged content select renders do not rewrite the direction probe or select direction', async ({ page }) => {
  const select = page.getByRole('combobox', { name: 'Direction probe' })
  await expect(select).toHaveAttribute('dir', 'ltr')
  const observed = await select.evaluateHandle(element => {
    const records: { type: string; attribute: string | null }[] = []
    const observer = new MutationObserver(changes => {
      records.push(...changes.map(change => ({ type: change.type, attribute: change.attributeName })))
    })
    observer.observe(element, { attributes: true, attributeFilter: ['dir'] })
    observer.observe(element.nextElementSibling!, { childList: true, subtree: true, characterData: true })
    return { records, disconnect: () => observer.disconnect() }
  })
  try {
    for (let render = 1; render <= 5; render++) {
      await page.getByRole('button', { name: 'Rerender content select', exact: true }).click()
      await expect(page.locator('#content-direction')).toHaveAttribute('data-render', String(render))
    }
    expect(await observed.evaluate(state => state.records)).toEqual([])
  } finally {
    await observed.evaluate(state => state.disconnect())
    await observed.dispose()
  }
})

test('content select recalculates changed labels and respects neutral content, inherited style and explicit direction', async ({ page }) => {
  const select = page.getByRole('combobox', { name: 'Direction probe' })
  await expect(select).toHaveAttribute('dir', 'ltr')
  await page.getByRole('button', { name: 'Change selected label', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'rtl')
  await page.getByRole('button', { name: 'Change selected label', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'ltr')
  await select.selectOption('arabic')
  await expect(select).toHaveAttribute('dir', 'rtl')
  await select.selectOption('neutral')
  await expect(select).toHaveAttribute('dir', 'ltr')
  await page.getByRole('button', { name: 'Change inherited direction', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'ltr')
  await page.addStyleTag({ content: '#content-direction bdi { direction: inherit; }' })
  await page.getByRole('button', { name: 'Rerender content select', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'rtl')
  await page.getByRole('button', { name: 'Change inherited direction', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'ltr')
  await page.getByRole('button', { name: 'Change explicit direction', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'rtl')
  await page.getByRole('button', { name: 'Change explicit direction', exact: true }).click()
  await select.selectOption('arabic')
  await expect(select).toHaveAttribute('dir', 'ltr')
  await page.getByRole('button', { name: 'Change inherited direction', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'ltr')
  await page.getByRole('button', { name: 'Use content direction', exact: true }).click()
  await expect(select).toHaveAttribute('dir', 'rtl')
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
  await expect(page.locator('.wiki-article .wiki-infobox dd')).toHaveCSS('direction', 'rtl')
  await expect(page.locator('.wiki-prose code')).toHaveCSS('direction', 'ltr')
  await expect(page.locator('.wiki-prose blockquote')).toHaveCSS('direction', 'rtl')
  await expect(page.locator('.wiki-prose ul')).toHaveCSS('direction', 'rtl')
  expect(await page.locator('.wiki-lead').evaluate(element => getComputedStyle(element, '::first-letter').float)).toBe('none')
  await expect(page.locator('.wiki-article-header')).toHaveCSS('direction', 'ltr')
})

test('Arabic interface preserves independently directed Wiki prose, fields and Markdown', async ({ page }) => {
  for (const direction of ['rtl', 'ltr', 'rtl']) {
    await page.evaluate(direction => {
      document.documentElement.lang = direction === 'rtl' ? 'ar' : 'en'
      document.documentElement.dir = direction
    }, direction)
    await expect(page.locator('header').first()).toHaveCSS('direction', direction)
    await expect(page.getByRole('textbox', { name: 'Scene name', exact: true })).toHaveCSS('direction', 'rtl')
    const markdown = page.getByRole('textbox', { name: 'Mixed Markdown' })
    await expect(markdown.locator('.cm-line').first()).toHaveCSS('direction', 'rtl')
    await expect(markdown.locator('.cm-line').nth(1)).toHaveCSS('direction', 'ltr')
    await expect(page.locator('.wiki-prose p').first()).toHaveCSS('direction', 'rtl')
    await expect(page.locator('.wiki-prose p').nth(1)).toHaveCSS('direction', 'ltr')
    await expect(page.locator('.wiki-prose code')).toHaveCSS('direction', 'ltr')
    await expect(page.locator('.wiki-prose ul')).toHaveCSS('direction', 'rtl')
    expect(await page.locator('.wiki-lead').evaluate(element => getComputedStyle(element, '::first-letter').float)).toBe('none')
  }
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

async function setInterface(page: Page, direction: 'rtl' | 'ltr'): Promise<void> {
  await page.evaluate(direction => {
    document.documentElement.lang = direction === 'rtl' ? 'ar' : 'en'
    document.documentElement.dir = direction
  }, direction)
}

for (const direction of ['rtl', 'ltr'] as const) {
  test(`empty fields inherit the ${direction} interface and follow typed letters`, async ({ page }) => {
    await setInterface(page, direction)
    const fields = [page.getByLabel('Empty metadata'), page.getByRole('textbox', { name: 'Nickname' }), page.getByRole('textbox', { name: 'Notes' })]
    for (const field of fields) {
      await expect(field).not.toHaveAttribute('dir', /.*/)
      await expect(field).toHaveCSS('direction', direction)
      await field.fill('123')
      await expect(field).not.toHaveAttribute('dir', /.*/)
      await expect(field).toHaveCSS('direction', direction)
      await field.fill('ليلى')
      await expect(field).toHaveCSS('direction', 'rtl')
      await field.fill('Layla')
      await expect(field).toHaveCSS('direction', 'ltr')
      await field.fill('')
      await expect(field).not.toHaveAttribute('dir', /.*/)
      await expect(field).toHaveCSS('direction', direction)
    }
  })

  test(`number-only infobox values and select options start on the ${direction} side`, async ({ page }) => {
    await setInterface(page, direction)
    const age = page.locator('#numeric-infobox dd').first()
    await expect(age).toHaveText('46')
    await expect(age).toHaveCSS('direction', direction)
    const edge = direction === 'rtl' ? 'right' : 'left'
    for (const name of ['Arabic select', 'Percent select', 'Latin select']) {
      await expect(page.getByRole('combobox', { name }).locator('option').first()).toHaveCSS('text-align', edge)
    }
    await expect(page.getByRole('combobox', { name: 'Latin select' }).locator('option').nth(1)).toHaveCSS('unicode-bidi', 'plaintext')
  })

  test(`an empty Markdown line carries no direction and its placeholder starts on the ${direction} side`, async ({ page }) => {
    await setInterface(page, direction)
    const editor = page.getByRole('textbox', { name: 'Empty Markdown' })
    await expect(editor.locator('.cm-line').first()).not.toHaveAttribute('dir', /.*/)
    const box = (await editor.locator('.cm-placeholder').boundingBox())!
    const surface = (await editor.boundingBox())!
    const middle = surface.x + surface.width / 2
    expect(direction === 'rtl' ? box.x + box.width / 2 > middle : box.x + box.width / 2 < middle).toBe(true)
  })
}

test('Arabic interface fields render with their text on the start side', async ({ page }) => {
  await setInterface(page, 'rtl')
  const directory = 'out/issue78/fields'
  await mkdir(directory, { recursive: true })
  await page.setViewportSize({ width: 900, height: 1500 })
  await page.locator('#fields').screenshot({ path: `${directory}/arabic-fields.png` })
  await page.locator('#numeric-infobox').screenshot({ path: `${directory}/arabic-infobox.png` })
})
