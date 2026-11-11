import { expect, test } from '@playwright/test'
import { buildWritingAppearance } from './fixtures/writingAppearance'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

let url: string
test.beforeAll(async () => { url = await buildWritingAppearance() })
test.beforeEach(async ({ page }) => {
  await page.goto(url)
  await expect(page.frameLocator('iframe').locator('.writing-book-heading')).toBeVisible()
})

test('continuous editor follows the approved document hierarchy and compact scene rail', async ({ page }, testInfo) => {
  const canvas = page.frameLocator('iframe')
  await expect(page.getByRole('button', { name: 'Manuscript', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const label = await page.locator('.writing-scope-toolbar > .writing-eyebrow').boundingBox()
  const segments = await page.locator('.writing-scope-segments').boundingBox()
  expect(segments!.x - label!.x - label!.width).toBeLessThanOrEqual(16)
  await expect(canvas.locator('.writing-book-heading h1')).toHaveText('The Cartographer’s Silence')
  await expect(canvas.locator('.writing-chapter-heading h2').first()).toHaveText('The city that forgot')
  await expect(canvas.locator('.writing-scene').first()).not.toContainText('Hidden scene title')
  await expect(canvas.locator('.nv-page')).toHaveCount(0)
  const rail = canvas.locator('.writing-scene-margin').first()
  await expect(rail.locator('button[aria-expanded]')).toHaveAttribute('aria-expanded', 'false')
  await expect(rail.locator('textarea')).toHaveCount(0)
  const size = await rail.boundingBox()
  expect(size!.width).toBeLessThanOrEqual(156)
  const prose = await canvas.locator('.writing-scene').first().boundingBox()
  expect(prose!.x - (size!.x + size!.width)).toBeLessThanOrEqual(16)
  await page.screenshot({ path: testInfo.outputPath('editor-desktop.png') })
  await page.locator('.writing-structure-action').first().click()
  await page.locator('.writing-structure-action').last().click()
  expect(await page.evaluate('window.structures')).toEqual(['sceneBreak', 'chapterHeading'])
})

test('German synopsis controls keep UI sizing with large prose and dimming', async ({ page }, testInfo) => {
  await page.evaluate('window.changeLanguage("de")')
  const canvas = page.frameLocator('iframe')
  await page.locator('iframe').evaluate(element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as { setFont(family: string, size: number): void; setComposeDimming(enabled: boolean): void }
    live.setFont('Georgia', 30); live.setComposeDimming(true)
  })
  const rail = canvas.locator('.writing-scene-margin').first()
  const synopsis = rail.getByRole('button', { name: /^Zusammenfassung$/i })
  await expect(synopsis).toHaveCSS('font-size', '16.9px')
  expect(await synopsis.evaluate(button => button.scrollWidth - button.clientWidth)).toBeLessThanOrEqual(1)
  expect(await rail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await expect(canvas.locator('.writing-scene-chrome').nth(1)).toHaveCSS('opacity', '1')
  await synopsis.click()
  await expect(rail.locator('textarea')).toHaveValue(/Elara discovers/)
  await page.screenshot({ path: testInfo.outputPath('editor-german-synopsis.png') })
})

for (const language of ['de', 'ar']) for (const zoom of [1, 2]) {
  test(`${language} scene information fits its rail at ${zoom * 100}% zoom`, async ({ page }) => {
    const rail = page.frameLocator('iframe').locator('.writing-scene-margin').first()
    await expect(rail).toHaveCSS('font-size', '16.9px')
    await page.evaluate(language => (window as unknown as { changeLanguage(language: string): Promise<void> }).changeLanguage(language), language)
    await page.locator('iframe').evaluate((element, { language, zoom }) => {
      const editor = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      editor.setInterfaceLanguage(language, language === 'ar' ? 'rtl' : 'ltr')
      editor.setPageView(true)
      editor.setWritingZoom(zoom)
    }, { language, zoom })
    await expect(rail).toHaveCSS('font-size', `${13 * zoom}px`)
    for (const expanded of [false, true]) {
      if (expanded) await rail.locator('button[aria-expanded]').click()
      await expect(rail.locator('button[aria-expanded]')).toHaveAttribute('aria-expanded', String(expanded))
      await expect.poll(() => rail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      for (const control of await rail.locator('button, select, textarea').all()) {
        expect(await control.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      }
    }
  })
}

test('scope switches and optional pages retain the continuous editor controls', async ({ page }) => {
  const canvas = page.frameLocator('iframe')
  await page.getByRole('button', { name: 'Scene', exact: true }).first().click()
  await expect(canvas.locator('.writing-scene')).toHaveCount(1)
  await expect(canvas.locator('.writing-book-heading')).toHaveCount(0)
  await page.getByRole('button', { name: 'Manuscript', exact: true }).click()
  await expect(canvas.locator('.writing-scene')).toHaveCount(3)
  await page.getByRole('button', { name: 'Page view', exact: true }).click()
  await expect(canvas.locator('.nv-page').first()).toBeVisible()
  await page.getByRole('button', { name: 'Page view', exact: true }).click()
  await expect(canvas.locator('.nv-page')).toHaveCount(0)
})

test('Focus scene isolates the scene beside its button and keeps its ordinal', async ({ page }) => {
  const canvas = page.frameLocator('iframe')
  await canvas.getByRole('button', { name: 'Focus scene', exact: true }).nth(1).click()
  await expect(canvas.locator('.writing-scene')).toHaveCount(1)
  await expect(canvas.locator('.writing-scene')).toHaveAttribute('data-writing-scene', 'second')
  await expect(canvas.locator('.writing-scene-number')).toHaveText('Scene 02')
})

test('narrow writing pane keeps synopsis above prose without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 500, height: 900 })
  const canvas = page.frameLocator('iframe')
  await expect(canvas.locator('body')).toHaveClass(/writing-narrow/)
  const rail = await canvas.locator('.writing-scene-margin').first().boundingBox()
  const prose = await canvas.locator('.writing-scene').first().boundingBox()
  expect(rail!.y + rail!.height).toBeLessThanOrEqual(prose!.y)
  const width = await canvas.locator('body').evaluate(body => [body.scrollWidth, body.ownerDocument.documentElement.clientWidth])
  expect(width[0]).toBeLessThanOrEqual(width[1])
  await page.screenshot({ path: testInfo.outputPath('editor-narrow.png') })
})

test('editor remains readable beside two panels at a typical desktop width', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 950 })
  const canvas = page.frameLocator('iframe')
  const prose = await canvas.locator('.writing-scene').first().boundingBox()
  expect(prose!.width).toBeGreaterThan(700)
  await page.screenshot({ path: testInfo.outputPath('editor-with-side-panels-width.png') })
})

test('writing starts at a readable size independently of the small print font', async ({ page }) => {
  const prose = page.frameLocator('iframe').locator('.writing-scene p').first()
  await expect.poll(() => prose.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(22)
  await expect(prose).toHaveCSS('font-family', /Georgia/)
})

test('text zoom reflows prose while the document and scene rail stay inside the pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 950 })
  const canvas = page.frameLocator('iframe')
  await expect(canvas.locator('.writing-scene-margin').first()).toHaveCSS('font-size', '16.9px')
  const setZoom = (factor: number) => page.locator('iframe').evaluate((element, zoom) => {
    ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(zoom)
  }, factor)
  await setZoom(1)
  const prose = canvas.locator('.writing-scene p').nth(1)
  const baseline = await prose.boundingBox()
  const heading = await canvas.locator('.writing-book-heading').boundingBox()
  const rail = await canvas.locator('.writing-scene-margin').first().boundingBox()
  for (const zoom of [2, 3, .5, 1]) {
    await setZoom(zoom)
    await expect(prose).toHaveCSS('font-size', `${17 * zoom}px`)
    const after = await prose.boundingBox()
    expect(after!.x).toBeGreaterThanOrEqual(0)
    expect(after!.x + after!.width).toBeLessThanOrEqual(1000)
    if (zoom > 1) expect(after!.height).toBeGreaterThan(baseline!.height)
    expect((await canvas.locator('.writing-book-heading').boundingBox())!.x).toBeCloseTo(heading!.x, 0)
    expect((await canvas.locator('.writing-scene-margin').first().boundingBox())!.width).toBeCloseTo(rail!.width * zoom, 0)
    expect(await canvas.locator('#editor-wrapper').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    if (zoom === 2) await page.screenshot({ path: testInfo.outputPath('editor-text-zoom-200.png') })
  }
})

test('zoom enlarges chapter titles and scene information as well as prose', async ({ page }) => {
  const frame = page.frameLocator('iframe')
  await page.locator('iframe').evaluate(element => ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(1))
  const title = frame.locator('.writing-chapter-heading h2').first()
  const count = frame.locator('.writing-scene-margin small').first()
  const sizes = await Promise.all([title, count].map(locator => locator.evaluate(element => parseFloat(getComputedStyle(element).fontSize))))
  await page.locator('iframe').evaluate(element => ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(2))
  await expect(title).toHaveCSS('font-size', `${sizes[0] * 2}px`)
  await expect(count).toHaveCSS('font-size', `${sizes[1] * 2}px`)
  await expect(title.locator('button')).toHaveCSS('font-size', `${sizes[0] * 2}px`)
})

test('scene, chapter and act names and scene stage can be changed at their displayed positions', async ({ page }) => {
  const canvas = page.frameLocator('iframe')
  const rail = canvas.locator('.writing-scene-margin').first()
  await rail.getByRole('button', { name: 'Scene name', exact: true }).click()
  await rail.getByRole('textbox', { name: 'Scene name', exact: true }).fill('The last mapmaker')
  await rail.getByRole('textbox', { name: 'Scene name', exact: true }).press('Enter')
  await rail.getByRole('combobox').selectOption('draft')
  const chapter = canvas.locator('.writing-chapter-heading').first()
  await chapter.locator('h2 button').click()
  await chapter.locator('h2 input').fill('A city erased')
  await chapter.locator('h2 input').press('Enter')
  await chapter.locator('.writing-act-name button').click()
  await chapter.locator('.writing-act-name input').fill('The discovery')
  await chapter.locator('.writing-act-name input').press('Enter')
  await expect.poll(() => page.evaluate('window.metadataWrites')).toEqual([
    ['scene', 'chapter-1', 'first', 'The last mapmaker'], ['stage', 'chapter-1', 'first', 'draft'],
    ['chapter', 'chapter-1', 'A city erased'], { kind: 'renameAct', oldName: 'Part one', newName: 'The discovery' }
  ])
  await expect(canvas.locator('.writing-book-heading .writing-eyebrow')).toHaveCount(0)
})

test('inline scene and chapter buttons target the displayed boundaries', async ({ page }, testInfo) => {
  const canvas = page.frameLocator('iframe')
  const second = canvas.locator('.writing-scene-chrome').filter({ has: canvas.locator('.writing-scene-number', { hasText: 'Scene 02' }) })
  await second.locator('[data-writing-insert="scene"]').click()
  await expect.poll(() => page.evaluate('window.structures.at(-1)')).toMatchObject({
    command: 'insertScene', paneId: 'appearance', sceneDestination: { chapterGuid: 'chapter-1', beforeSceneId: 'second' }
  })
  const chapter = canvas.locator('.writing-scene-chrome').filter({ has: canvas.locator('h2', { hasText: 'Beneath the ink' }) })
  await chapter.locator('[data-writing-insert="chapter"]').click()
  await expect.poll(() => page.evaluate('window.structures.at(-1)')).toMatchObject({
    command: 'insertChapter', paneId: 'appearance', destination: { beforeChapterGuid: 'chapter-2', actName: 'Part one' }
  })
  await page.screenshot({ path: testInfo.outputPath('editor-inline-insertion.png') })
  await canvas.locator('.writing-end [data-writing-insert="scene"]').click()
  await expect.poll(() => page.evaluate('window.structures.at(-1)')).toMatchObject({
    command: 'insertScene', sceneDestination: { chapterGuid: 'chapter-2', beforeSceneId: null }
  })
})

test('expanded synopsis grows to its content and shrinks again', async ({ page }) => {
  const rail = page.frameLocator('iframe').locator('.writing-scene-margin').first()
  await rail.getByRole('button', { name: 'Synopsis', exact: true }).click()
  const input = rail.locator('textarea')
  await expect(input).toBeEnabled()
  await input.fill('A scene synopsis with several lines of detail. '.repeat(8))
  await expect.poll(() => input.evaluate(element => element.clientHeight)).toBeGreaterThan(180)
  expect(await input.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2)
  const expanded = (await input.boundingBox())!.height
  await input.fill('Short synopsis.')
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThan(expanded)
  await input.fill('A long synopsis must remain reachable within the writing pane. '.repeat(80))
  expect((await rail.boundingBox())!.height).toBeLessThan((await page.locator('iframe').boundingBox())!.height)
  expect(await rail.evaluate(element => element.scrollHeight)).toBeGreaterThan((await rail.boundingBox())!.height)
})

test('scene information stays visible while scrolling through its prose', async ({ page }) => {
  const frame = page.frameLocator('iframe')
  const rail = frame.locator('.writing-scene-margin').first()
  const position = (await rail.boundingBox())!.y
  await frame.locator('#editor-wrapper').evaluate((element, top) => { element.scrollTop = top }, position + 100)
  await expect.poll(async () => (await rail.boundingBox())!.y).toBeGreaterThanOrEqual((await page.locator('iframe').boundingBox())!.y)
  expect((await rail.boundingBox())!.y).toBeLessThan((await page.locator('iframe').boundingBox())!.y + 30)
})

test('shared synopsis text follows editor zoom and expands with its content', async ({ page }) => {
  await page.evaluate('window.useSharedSynopsis()')
  const rail = page.frameLocator('iframe').locator('.writing-scene-margin').first()
  await rail.getByRole('button', { name: 'Synopsis', exact: true }).click()
  const field = rail.locator('.cm-content')
  await expect(field).toHaveText('Shared synopsis')
  await page.locator('iframe').evaluate(element => ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(2))
  await expect(field).toHaveCSS('font-size', '26px')
  const initial = (await field.boundingBox())!.height
  await field.fill('Shared synopsis text also needs enough room to be read. '.repeat(8))
  await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(initial)
})

test('enabled book width applies the chosen text measure and book typography at the selected zoom', async ({ page }) => {
  const frame = page.frameLocator('iframe')
  const paragraph = frame.locator('.writing-scene p').first()
  await page.evaluate('window.setBookLayout(true, 4)')
  await page.locator('iframe').evaluate(element => ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(1))
  await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeCloseTo(384, 0)
  await expect(paragraph).toHaveCSS('font-size', '11px')
  await expect(paragraph).toHaveCSS('font-family', /Times New Roman/)
  await page.evaluate('window.setBookLayout(true, 6)')
  await page.locator('iframe').evaluate(element => ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(1))
  await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeCloseTo(576, 0)
  await page.evaluate('window.setBookLayout(false)')
  await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeGreaterThan(700)
})

test('book text measure is also honored in page view and in a narrow pane', async ({ page }) => {
  await page.evaluate('window.setBookLayout(true, 4)')
  await page.getByRole('button', { name: 'Page view', exact: true }).click()
  await page.locator('iframe').evaluate(element => ((element as HTMLIFrameElement).contentWindow as unknown as EditorWindow).setWritingZoom(2))
  const canvas = page.frameLocator('iframe')
  await expect(canvas.locator('.nv-page').first()).toBeVisible()
  await expect.poll(async () => (await canvas.locator('.writing-scene p').first().boundingBox())!.width).toBeCloseTo(528, 0)
  await page.setViewportSize({ width: 500, height: 900 })
  await expect.poll(() => canvas.locator('#editor-wrapper').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
})

test('an existing book opens with its saved paper and book font fitted into the writing pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1718, height: 1100 })
  await page.goto(`${url}?book=1`)
  const canvas = page.frameLocator('iframe')
  await expect(page.getByRole('button', { name: 'Page view', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const paper = canvas.locator('.nv-page').first(), paragraph = paper.locator('p').first()
  await expect(paragraph).toHaveCSS('font-family', /Times New Roman/)
  await expect(paragraph).toHaveCSS('font-size', '33px')
  expect(await canvas.locator('.writing-scene-margin small').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeLessThan(33)
  await expect.poll(async () => (await paper.boundingBox())!.width).toBeCloseTo(1056, 0)
  await expect.poll(async () => (await paper.boundingBox())!.height).toBeCloseTo(1848, 0)
  expect(await canvas.locator('#editor-wrapper').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('saved-book-page.png') })
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(paragraph).toHaveCSS('font-size', '33px')
  await expect.poll(() => canvas.locator('#editor-wrapper').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
})

for (const pages of [false, true]) {
  test(`text zoom preserves the caret and keeps prose visible with pages=${pages}`, async ({ page }) => {
    if (pages) await page.getByRole('button', { name: 'Page view', exact: true }).click()
    const canvas = page.frameLocator('iframe')
    await canvas.locator('.writing-scene p').first().click()
    const before = await page.locator('iframe').evaluate(element => {
      const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      live.restoreWritingSelection({ anchor: { sceneId: 'first', offset: 50, affinity: 'after' }, focus: { sceneId: 'first', offset: 50, affinity: 'after' } })
      live.focusEditor()
      return live.getWritingSelection()
    })
    await page.locator('iframe').evaluate(element => {
      const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      live.setWritingZoom(2, 'middle')
    })
    await expect.poll(() => page.locator('iframe').evaluate(element => {
      const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
      return live.getWritingSelection()
    })).toEqual(before)
    await expect.poll(() => canvas.locator('#editor-wrapper').evaluate(wrapper => {
      const caret = wrapper.ownerDocument.getSelection()!.getRangeAt(0).getBoundingClientRect()
      const viewport = wrapper.getBoundingClientRect()
      return caret.left >= viewport.left && caret.right <= viewport.right && caret.top >= viewport.top && caret.bottom <= viewport.bottom
    })).toBe(true)
    expect(await canvas.locator('#editor-wrapper').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await page.keyboard.type('visible')
    await expect(canvas.locator('.writing-scene').first()).toContainText('visible')
  })
}
