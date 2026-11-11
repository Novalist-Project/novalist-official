import { expect, test } from '@playwright/test'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { buildWritingAppearance } from './fixtures/writingAppearance'

let url: string
test.beforeAll(async () => { url = await buildWritingAppearance() })

for (const language of ['de', 'ar']) for (const mode of ['ordinary', 'book', 'page']) for (const zoom of [1, 2]) {
  test(`${language} ${mode} rail uses spare margin before wrapping at ${zoom * 100}%`, async ({ page }) => {
    await page.goto(`${url}?sceneTitle=${encodeURIComponent('Szene 1: Ein Morgen am Meer')}`)
    const canvas = page.frameLocator('iframe')
    const rail = canvas.locator('.writing-scene-margin').first()
    await expect(rail).toHaveCSS('font-size', '16.9px')
    await page.evaluate(language => (window as unknown as { changeLanguage(language: string): Promise<void> }).changeLanguage(language), language)
    await page.locator('iframe').evaluate((element, { language, mode, zoom }) => {
      const editor = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      editor.setInterfaceLanguage(language, language === 'ar' ? 'rtl' : 'ltr')
      editor.setBookWidth(mode === 'book', 500)
      editor.setPageView(mode === 'page')
      editor.setWritingZoom(zoom)
    }, { language, mode, zoom })
    await expect(rail).toHaveCSS('font-size', `${13 * zoom}px`)
    const reserved = await rail.evaluate((element, zoom) => parseFloat(getComputedStyle(element).getPropertyValue('--nl-writing-margin-collapsed')) * zoom, zoom)
    await expect.poll(async () => (await rail.boundingBox())!.width).toBeGreaterThan(reserved + 10)
    const wide = (await rail.boundingBox())!
    const synopsis = rail.locator('button[aria-expanded]')
    const singleLineHeight = await synopsis.evaluate(element => {
      const style = getComputedStyle(element)
      return parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    })
    expect((await synopsis.boundingBox())!.height).toBeLessThanOrEqual(singleLineHeight + 1)

    const prose = canvas.locator('.writing-scene p').first()
    const original = (await prose.boundingBox())!
    await rail.evaluate((element, width) => { element.style.width = `${width}px` }, reserved)
    const fixedRail = (await rail.boundingBox())!
    const unchanged = (await prose.boundingBox())!
    expect(unchanged.x).toBeCloseTo(original.x, 1)
    expect(unchanged.width).toBeCloseTo(original.width, 1)
    expect(language === 'ar' ? wide.x : wide.x + wide.width).toBeCloseTo(language === 'ar' ? fixedRail.x : fixedRail.x + fixedRail.width, 1)
    await rail.evaluate(element => element.style.removeProperty('width'))

    const narrowWidth = zoom === 1 ? 600 : 800
    await page.setViewportSize({ width: narrowWidth, height: 1000 })
    await expect.poll(async () => (await rail.boundingBox())!.width).toBeLessThan(wide.width - 10)
    const narrow = (await rail.boundingBox())!
    const scene = (await canvas.locator('.writing-scene').first().boundingBox())!
    expect(narrow.x).toBeGreaterThanOrEqual(0)
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(narrowWidth)
    expect(language === 'ar' ? narrow.x >= scene.x + scene.width : narrow.x + narrow.width <= scene.x).toBe(true)
    const title = rail.locator('.writing-metadata-name')
    expect((await title.boundingBox())!.height).toBeGreaterThan(await title.evaluate(element => parseFloat(getComputedStyle(element).lineHeight)))
    expect(await rail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    await page.setViewportSize({ width: 500, height: 1000 })
    await expect(canvas.locator('body')).toHaveClass(/writing-narrow/)
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(500)
    expect(await canvas.locator('#editor-wrapper').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })
}
