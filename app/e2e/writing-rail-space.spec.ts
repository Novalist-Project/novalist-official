import { expect, test } from '@playwright/test'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { buildWritingAppearance } from './fixtures/writingAppearance'

let url: string
test.beforeAll(async () => { url = await buildWritingAppearance() })

for (const language of ['de', 'ar']) for (const mode of ['ordinary', 'book', 'page']) {
  test(`${language} ${mode} panels keep their dimensions and prose position when synopses change`, async ({ page }) => {
    const query = new URLSearchParams({ short: '', 'sceneTitle-first': 'One',
      'sceneTitle-second': 'A scene with a much longer name that needs more than one line' })
    await page.goto(`${url}?${query}`)
    const canvas = page.frameLocator('iframe')
    const rails = canvas.locator('.writing-scene-margin')
    await expect(rails.first()).toHaveCSS('font-size', '16.9px')
    await page.evaluate(language => (window as unknown as { changeLanguage(language: string): Promise<void> }).changeLanguage(language), language)
    await page.locator('iframe').evaluate((element, { language, mode }) => {
      const editor = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      editor.setInterfaceLanguage(language, language === 'ar' ? 'rtl' : 'ltr')
      editor.setBookWidth(mode === 'book', 500)
      editor.setPageView(mode === 'page')
    }, { language, mode })
    const layout = () => canvas.locator('#editor-wrapper').evaluate(viewport => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y + viewport.scrollTop, width: rect.width, height: rect.height }
      }
      return {
        rails: Array.from(viewport.querySelectorAll('.writing-scene-margin'), box),
        prose: Array.from(viewport.querySelectorAll('.writing-scene'), box)
      }
    })
    await expect.poll(async () => (await layout()).rails.map(rail => rail.width)).toEqual([
      (await rails.first().boundingBox())!.width, (await rails.first().boundingBox())!.width, (await rails.first().boundingBox())!.width
    ])
    const before = await layout()
    for (const rail of before.rails) expect(rail.height).toBeCloseTo(before.rails[0].height, 1)
    const focus = rails.first().locator('.writing-focus-scene')
    const focusOffset = () => focus.evaluate(element => element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top)
    const collapsedOffset = await focusOffset()
    const collapsedGap = await focus.evaluate(element => element.getBoundingClientRect().top -
      element.parentElement!.querySelector('button[aria-expanded]')!.getBoundingClientRect().bottom)
    expect(collapsedGap).toBeLessThanOrEqual(20)
    const input = rails.first().locator('textarea')
    await rails.first().locator('button[aria-expanded]').click()
    await expect(input).toBeEnabled()
    expect(await focusOffset()).toBeGreaterThan(collapsedOffset)
    for (const text of ['Short synopsis.', 'A long synopsis should scroll inside the panel. '.repeat(100)]) {
      await input.fill(text)
      await expect.poll(layout).toEqual(before)
    }
    expect(await input.evaluate(element => element.scrollHeight)).toBeGreaterThan((await input.boundingBox())!.height)
    await input.evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await input.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await rails.first().locator('button[aria-expanded]').click()
    await expect.poll(layout).toEqual(before)
    expect(await focusOffset()).toBe(collapsedOffset)
  })
}

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
