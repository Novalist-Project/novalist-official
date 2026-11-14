import { expect, test, type Locator, type Page } from '@playwright/test'
import { buildArabicDetails, buildArabicInterface } from './fixtures/arabicInterface'

let url: string
let detailsUrl: string
test.beforeAll(async () => { url = await buildArabicInterface(); detailsUrl = await buildArabicDetails() })
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

const shots = 'out/issue78/chrome'
const directional = ['settings-back', 'open-book', 'ctx-collapsed', 'binder-closed', 'binder-open', 'reply']
const scaleOf = (page: Page, id: string): Promise<string> =>
  page.locator(`#${id}`).evaluate(node => getComputedStyle(node).scale)
const setLanguage = (page: Page, language: string): Promise<void> =>
  page.evaluate(code => (window as unknown as { setLanguage(code: string): Promise<unknown> }).setLanguage(code).then(() => undefined), language)

test('directional icons mirror in Arabic and stay put in English', async ({ page }) => {
  await page.goto(detailsUrl)
  for (const id of [...directional, 'ctx-open', 'plain']) expect(await scaleOf(page, id)).toBe('none')
  await setLanguage(page, 'ar')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  for (const id of directional) expect(await scaleOf(page, id)).toBe('-1 1')
  for (const id of ['ctx-open', 'plain']) expect(await scaleOf(page, id)).toBe('none')
  await page.locator('#icons').screenshot({ path: `${shots}/icons-ar.png` })
  await setLanguage(page, 'en')
  await page.locator('#icons').screenshot({ path: `${shots}/icons-en.png` })
})

test('rows in the reported lists follow the interface direction', async ({ page }) => {
  await page.goto(detailsUrl)
  await setLanguage(page, 'ar')
  const textEdge = (selector: string): Promise<number> => page.locator(selector).evaluate(node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect().right
  })
  for (const selector of ['.dashboard-activity-chapter', '.wiki-entry-subtitle', '.wiki-entry-title', '.binder-scene-title'])
    await expect(page.locator(selector)).toHaveCSS('text-align', 'start')
  const sceneRight = await textEdge('.dashboard-activity-scene')
  expect(await textEdge('.dashboard-activity-chapter')).toBeCloseTo(sceneRight, 0)
  const wikiRight = await textEdge('.wiki-entry-title')
  expect(await textEdge('.wiki-entry-subtitle')).toBeLessThanOrEqual(wikiRight + 1)
  expect((await box(page.locator('.wiki-entry-subtitle'))).x + (await box(page.locator('.wiki-entry-subtitle'))).width)
    .toBeCloseTo((await box(page.locator('.wiki-entry-title'))).x + (await box(page.locator('.wiki-entry-title'))).width, 0)
  expect(await textEdge('.binder-scene-title')).toBeGreaterThan((await box(page.locator('.binder-scene-words'))).x)
  await page.locator('#recent').screenshot({ path: `${shots}/recent-scenes-ar.png` })
  await page.locator('#wiki').screenshot({ path: `${shots}/wiki-rows-ar.png` })
  await page.locator('#scenes').screenshot({ path: `${shots}/scene-list-ar.png` })
  await setLanguage(page, 'en')
  for (const selector of ['.dashboard-activity-chapter', '.wiki-entry-subtitle', '.binder-scene-title'])
    await expect(page.locator(selector)).toHaveCSS('text-align', 'start')
  expect(await textEdge('.dashboard-activity-chapter')).toBeLessThan(sceneRight)
})

test('the library cover opens on its spine in both directions and stays shut under reduced motion', async ({ page }) => {
  await page.goto(detailsUrl)
  const front = page.locator('.volume-cover-front')
  const card = page.locator('.start-recent-card')
  const opened = async (): Promise<{ turn: number; originX: number }> => {
    await expect.poll(() => front.evaluate(node => getComputedStyle(node).transform)).not.toBe('none')
    await page.waitForTimeout(450)
    return front.evaluate(node => {
      const style = getComputedStyle(node)
      return { turn: new DOMMatrix(style.transform).m13, originX: parseFloat(style.transformOrigin) }
    })
  }
  await card.evaluate(node => node.setAttribute('aria-pressed', 'true'))
  const ltr = await opened()
  const width = (await box(front)).width
  await page.locator('#shelf').screenshot({ path: `${shots}/cover-pressed-ltr.png` })
  await setLanguage(page, 'ar')
  const rtl = await opened()
  await page.locator('#shelf').screenshot({ path: `${shots}/cover-pressed-rtl.png` })
  expect(ltr.originX).toBe(0)
  expect(rtl.originX).toBeGreaterThan(100)
  expect(Math.sign(ltr.turn)).toBe(-Math.sign(rtl.turn))
  expect(Math.abs(rtl.turn)).toBeCloseTo(Math.abs(ltr.turn), 3)
  expect(width).toBeGreaterThan(0)
  await card.evaluate(node => node.setAttribute('aria-pressed', 'false'))
  await card.hover()
  const hovered = await opened()
  expect(Math.sign(hovered.turn)).toBe(Math.sign(rtl.turn))
  await page.locator('#shelf').screenshot({ path: `${shots}/cover-hover-rtl.png` })
  await setLanguage(page, 'en')
  await page.mouse.move(0, 0)
  await card.hover()
  expect(Math.sign((await opened()).turn)).toBe(Math.sign(ltr.turn))
  await page.locator('#shelf').screenshot({ path: `${shots}/cover-hover-ltr.png` })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(front).toHaveCSS('transform', 'none')
  await setLanguage(page, 'ar')
  await expect(front).toHaveCSS('transform', 'none')
  await page.locator('#shelf').screenshot({ path: `${shots}/cover-reduced-motion-rtl.png` })
})
