import { expect, test, type Frame } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { buildWritingAppearance } from './fixtures/writingAppearance'
import { buildLegacyBookLayout, parityProse } from './fixtures/writingLegacyBookLayout'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

let currentUrl: string, legacyUrl: string
test.beforeAll(async () => {
  ;[currentUrl, legacyUrl] = await Promise.all([buildWritingAppearance(), buildLegacyBookLayout()])
})

async function measure(frame: Frame, selector: string) {
  return frame.evaluate(rootSelector => {
    const root = document.querySelector(rootSelector)!
    const paper = root.querySelector<HTMLElement>('.nv-page')!
    const style = getComputedStyle(paper)
    const paperBox = paper.getBoundingClientRect()
    const scale = paperBox.width / paper.offsetWidth
    const paragraphs = Array.from(root.querySelectorAll('p')).map(paragraph => {
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      const rect = paragraph.getBoundingClientRect()
      const textStyle = getComputedStyle(paragraph)
      return { width: rect.width, height: rect.height, fontFamily: textStyle.fontFamily,
        physicalFontSize: parseFloat(textStyle.fontSize) * scale,
        lines: new Set(Array.from(range.getClientRects(), box => Math.round(box.y * 100))).size }
    })
    return { paper: { width: paperBox.width, height: paperBox.height,
      paddingTop: parseFloat(style.paddingTop) * scale, paddingLeft: parseFloat(style.paddingLeft) * scale },
      pages: root.querySelectorAll('.nv-page').length, paragraphs }
  }, selector)
}

for (const zoom of [1, 2, 3]) {
  test(`book layout matches v3.7.2 typography and native page geometry at ${zoom * 100}%`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: 2400, height: 1500 })
    await page.goto(currentUrl)
    await expect(page.frameLocator('iframe').locator('.writing-scene')).toHaveCount(3)
    await page.getByRole('button', { name: 'Scene', exact: true }).first().click()
    await page.evaluate('window.setBookLayout(true, 4)')
    await page.locator('iframe').evaluate((element, html) => {
      const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      live.updateWritingScene({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter-1', sceneId: 'first', html, hash: 'parity', revision: 1 })
      live.setReadingComfort(1.95, 0, .8, 0)
      live.setBookParagraphSpacing(true)
    }, parityProse)
    await page.getByRole('button', { name: 'Page view', exact: true }).click()
    await page.locator('iframe').evaluate((element, factor) => {
      ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(factor)
    }, zoom)
    const current = page.frames()[1]
    await expect(current.locator('.writing-scene')).toHaveText(parityProse.replace(/<[^>]*>/g, ''))
    await expect(current.locator('.nv-page').first()).toBeVisible()
    const tokens = await current.evaluate(() => Object.fromEntries(Array.from(getComputedStyle(document.documentElement))
      .filter(property => property.startsWith('--nl-')).map(property => [property, getComputedStyle(document.documentElement).getPropertyValue(property)])))
    const legacy = await context.newPage()
    await legacy.setViewportSize({ width: 2400, height: 1500 })
    await legacy.goto(legacyUrl)
    await legacy.waitForFunction(() => typeof (window as unknown as EditorWindow).setContent === 'function')
    await legacy.evaluate(({ html, factor, variables }) => {
      for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value)
      const editor = window as unknown as EditorWindow
      editor.setContent(html)
      editor.setFont('Times New Roman', 11)
      editor.setBookWidth(true, 4 * 96)
      editor.setReadingComfort(1.95, 0, .8, 0)
      editor.setBookParagraphSpacing(true)
      editor.setPageView(true)
      editor.setWritingZoom(factor)
    }, { html: parityProse, factor: zoom, variables: tokens })
    await expect(legacy.locator('.nv-page').first()).toBeVisible()
    await expect(legacy.locator('#editor')).toHaveText(parityProse.replace(/<[^>]*>/g, ''))
    await Promise.all([current.evaluate(() => document.fonts.ready), legacy.evaluate(() => document.fonts.ready)])
    for (const frame of [current, legacy.mainFrame()]) {
      await frame.waitForFunction(() => !(window as unknown as { NovalistEditorState: { pageViewRepaginateScheduled: boolean } }).NovalistEditorState.pageViewRepaginateScheduled)
    }
    await expect.poll(() => current.locator('.writing-scene p').count()).toBe(5)
    const before = await measure(legacy.mainFrame(), '#editor')
    const after = await measure(current, '.writing-scene')
    const metrics = testInfo.outputPath('book-layout-metrics.json')
    await writeFile(metrics, JSON.stringify({ zoom, legacy: before, unified: after }, null, 2))
    await testInfo.attach('book-layout-metrics', { path: metrics, contentType: 'application/json' })
    expect.soft(after.paragraphs[0].fontFamily).toBe(before.paragraphs[0].fontFamily)
    expect.soft(after.paragraphs[0].physicalFontSize).toBeCloseTo(before.paragraphs[0].physicalFontSize, 1)
    for (const key of ['width', 'height', 'paddingTop', 'paddingLeft'] as const) expect.soft(after.paper[key], `paper ${key}`).toBeCloseTo(before.paper[key], 0)
    expect.soft(after.pages).toBe(before.pages)
    for (let index = 0; index < before.paragraphs.length; index++) {
      expect.soft(after.paragraphs[index].width, `paragraph ${index} width`).toBeCloseTo(before.paragraphs[index].width, 0)
      expect.soft(after.paragraphs[index].height, `paragraph ${index} height`).toBeCloseTo(before.paragraphs[index].height, 0)
      expect.soft(after.paragraphs[index].lines, `paragraph ${index} line breaks`).toBe(before.paragraphs[index].lines)
    }
    await legacy.close()
  })
}
