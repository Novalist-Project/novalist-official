import { expect, test, type Locator, type Page } from '@playwright/test'
import { buildArabicInterface } from './fixtures/arabicInterface'

let url: string
test.beforeAll(async () => { url = await buildArabicInterface() })
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error })
  await page.goto(url)
})

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const bounds = await locator.boundingBox()
  if (!bounds) throw new Error('Expected a visible component')
  return bounds
}

async function drag(page: Page, locator: Locator, delta: number): Promise<void> {
  const bounds = await box(locator)
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + delta, y, { steps: 4 })
  await page.mouse.up()
}

test('an Arabic regional OS locale starts the Arabic interface', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'language', { value: 'ar-EG' }))
  await page.reload()
  await expect(page.locator('#set-language')).toHaveValue('ar')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
})

test('Settings switches the shell to Arabic and restores English immediately', async ({ page }) => {
  await page.locator('#set-language').selectOption('ar')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  expect((await box(page.locator('.binder'))).x).toBeGreaterThan((await box(page.locator('.inspector'))).x)
  await expect(page.locator('label[for="set-language"]')).toContainText(/[\u0600-\u06ff]/)
  await page.screenshot({ path: 'out/arabic-interface/arabic-shell.png' })
  await page.locator('#set-language').selectOption('en')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  expect((await box(page.locator('.binder'))).x).toBeLessThan((await box(page.locator('.inspector'))).x)
})

test('mirrored side panel handles grow toward the visible interior edge', async ({ page }) => {
  await page.locator('#set-language').selectOption('ar')
  await drag(page, page.locator('.binder .panel-resizer'), -50)
  expect((await box(page.locator('.binder'))).width).toBeCloseTo(270, 0)
  await drag(page, page.locator('.inspector .panel-resizer'), 40)
  expect((await box(page.locator('.inspector'))).width).toBeCloseTo(260, 0)
  await page.locator('#set-language').selectOption('en')
  await drag(page, page.locator('.binder .panel-resizer'), 30)
  expect((await box(page.locator('.binder'))).width).toBeCloseTo(300, 0)
})

test('Arabic keeps saved pane geometry and literal left docking while resizing', async ({ page }) => {
  await page.locator('#set-language').selectOption('ar')
  const first = page.locator('.pane-leaf[data-view="dashboard"]')
  const second = page.locator('.pane-leaf[data-view="about"]')
  expect((await box(first)).x).toBeLessThan((await box(second)).x)
  await expect(first).toHaveCSS('direction', 'rtl')
  const initial = await box(first)
  await drag(page, page.locator('.pane-divider'), 50)
  expect((await box(first)).width).toBeGreaterThan(initial.width + 40)
  await page.getByRole('button', { name: 'Place notes', exact: true }).click()
  const left = first.locator('.notes-dock-left')
  expect((await box(left)).x).toBeLessThan((await box(first.locator('.notes-dock-right'))).x)
  await left.click()
  expect((await box(page.locator('.pane-leaf[data-view="sceneNotes"]'))).x).toBeLessThan((await box(first)).x)
})

test('Focus mode hover edges follow their panels and physical gutter widths after language changes', async ({ page }) => {
  await page.getByRole('button', { name: 'Enter Focus mode', exact: true }).click()
  for (const language of ['ar', 'en']) {
    await page.locator('#set-language').selectOption(language)
    const rtl = language === 'ar'
    const binderEdge = page.locator('.focus-edge-left')
    const inspectorEdge = page.locator('.focus-edge-right')
    await expect(binderEdge).toHaveCSS('width', rtl ? '320px' : '160px')
    await expect(inspectorEdge).toHaveCSS('width', rtl ? '160px' : '320px')
    for (const side of ['binder', 'inspector']) {
      const right = (side === 'binder') === rtl
      await page.mouse.move(right ? 1438 : 2, 600)
      const panel = page.locator(`.focus-panel-${side}`)
      await expect(panel).toHaveAttribute('aria-hidden', 'false')
      await expect.poll(async () => (await box(panel)).x > 720).toBe(right)
      await page.mouse.move(720, 600)
      await expect(panel).toHaveAttribute('aria-hidden', 'true')
    }
  }
})
