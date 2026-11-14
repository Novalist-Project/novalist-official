import { expect, test, type Page } from '@playwright/test'
import { buildWritingScopePosition } from './fixtures/writingScopePosition'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

let url: string
test.beforeAll(async () => { url = await buildWritingScopePosition() })
test.beforeEach(async ({ page }) => {
  await page.goto(url)
  await expect(page.frameLocator('iframe').locator('.writing-scene')).toHaveCount(4)
})

async function position(page: Page) {
  return page.locator('iframe').evaluate(element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    const selection = live.getWritingSelection()!
    const point = live.writingDomPoint(selection.focus)!
    const range = live.document.createRange()
    range.setStart(point.node, point.offset); range.collapse(true)
    const viewport = live.document.getElementById('editor-wrapper')!.getBoundingClientRect()
    return { selection, offset: range.getBoundingClientRect().top - viewport.top }
  })
}

test('Scene, Chapter and Manuscript preserve the current range and viewport instead of the old outline anchor', async ({ page }) => {
  await page.locator('iframe').evaluate(element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    const selection = { anchor: { sceneId: 'third', offset: 2260, affinity: 'after' as const }, focus: { sceneId: 'third', offset: 2200, affinity: 'after' as const } }
    live.revealWritingPoint(selection.focus, 240)
    live.restoreWritingSelection(selection)
  })
  await expect.poll(async () => (await position(page)).offset).toBeCloseTo(240, 0)
  const before = await position(page)
  for (const [scope, count] of [['scene', 1], ['chapter', 2], ['manuscript', 4], ['scene', 1]] as const) {
    await page.getByRole('button', { name: scope, exact: true }).click()
    await expect(page.frameLocator('iframe').locator('.writing-scene')).toHaveCount(count)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect.poll(async () => (await position(page)).selection).toEqual(before.selection)
    await expect.poll(async () => (await position(page)).offset).toBeCloseTo(before.offset, 0)
  }
})

test('scope narrowing follows the visible scene when the old caret is outside the viewport', async ({ page }) => {
  const before = await page.locator('iframe').evaluate(element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    live.restoreWritingSelection({ anchor: { sceneId: 'first', offset: 0, affinity: 'after' }, focus: { sceneId: 'first', offset: 0, affinity: 'after' } })
    const root = live.getWritingSceneRoot('fourth')!
    const wrapper = live.document.getElementById('editor-wrapper')!
    wrapper.scrollTop += root.getBoundingClientRect().top - wrapper.getBoundingClientRect().top + 140
    return root.getBoundingClientRect().top - wrapper.getBoundingClientRect().top
  })
  await page.getByRole('button', { name: 'scene', exact: true }).click()
  await expect(page.frameLocator('iframe').locator('.writing-scene')).toHaveCount(1)
  await expect(page.frameLocator('iframe').locator('.writing-scene')).toHaveAttribute('data-writing-scene', 'fourth')
  await expect.poll(() => page.locator('iframe').evaluate(element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    return live.getWritingSceneRoot('fourth')!.getBoundingClientRect().top - live.document.getElementById('editor-wrapper')!.getBoundingClientRect().top
  })).toBeCloseTo(before, 0)
})

test('scope changes retain a typed paragraph-end caret in zoomed page view', async ({ page }) => {
  await page.evaluate(() => {
    const model = (window as unknown as { scopeModel: {
      snapshots: { sceneId: string; bookId: string; draftId: string; chapterGuid: string }[]
      adapter: { transformScene(ref: unknown, transform: () => { html: string }): void }
      live: EditorWindow
    } }).scopeModel
    for (const snapshot of model.snapshots) model.adapter.transformScene(snapshot, () => ({ html: '<p><br></p>' }))
    model.live.setPageView(true)
    model.live.setWritingZoom(1.3)
  })
  const frame = page.frameLocator('iframe')
  await frame.locator('[data-writing-scene="first"]').click({ position: { x: 30, y: 15 } })
  await page.keyboard.type('Production typing persists.')
  const before = await position(page)
  expect(before.selection.focus.offset).toBe(27)
  for (const [scope, count] of [['scene', 1], ['manuscript', 4]] as const) {
    await page.getByRole('button', { name: scope, exact: true }).click()
    await expect(frame.locator('.writing-scene')).toHaveCount(count)
    await expect.poll(async () => (await position(page)).selection).toEqual(before.selection)
  }
})

test('scope changes retain the prose caret after editing and collapsing synopsis chrome', async ({ page }) => {
  const frame = page.frameLocator('iframe')
  const prose = frame.locator('[data-writing-scene="first"] p').first()
  await prose.click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('Production typing persists.')
  const before = await position(page)
  expect(before.selection.focus.offset).toBe(27)
  await page.locator('iframe').evaluate(element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    const chrome = live.document.createElement('div')
    chrome.dataset.editorChrome = 'writing'
    chrome.contentEditable = 'false'
    const button = live.document.createElement('button')
    button.type = 'button'
    button.textContent = 'Synopsis'
    button.addEventListener('click', () => {
      const input = chrome.querySelector('textarea')
      if (input) input.remove()
      else chrome.append(live.document.createElement('textarea'))
    })
    chrome.append(button)
    live.getWritingSceneRoot('first')!.before(chrome)
  })
  const synopsis = frame.getByRole('button', { name: 'Synopsis', exact: true })
  await synopsis.click()
  await frame.locator('textarea').fill('Synopsis typed before collapse.')
  await synopsis.click()
  for (const [scope, count] of [['scene', 1], ['manuscript', 4]] as const) {
    await page.getByRole('button', { name: scope, exact: true }).click()
    await expect(frame.locator('.writing-scene')).toHaveCount(count)
    await expect.poll(async () => (await position(page)).selection).toEqual(before.selection)
  }
})
