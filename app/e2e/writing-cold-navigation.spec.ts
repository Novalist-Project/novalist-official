import { expect, test } from '@playwright/test'
import { buildWritingAppearance } from './fixtures/writingAppearance'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

let url: string
test.beforeAll(async () => { url = await buildWritingAppearance() })

for (const pages of [false, true]) {
  test(`outline reveal reaches an unvisited scene and remains there with pages=${pages}`, async ({ page }) => {
    await page.goto(`${url}?long=1${pages ? '&book=1' : ''}`)
    const frame = page.frameLocator('iframe')
    await expect(frame.locator('[data-writing-scene]')).toHaveCount(40)
    await expect(frame.locator('.writing-book-heading')).toBeVisible()
    await expect(frame.locator('[data-writing-scene="first"] p').first()).toHaveCSS('font-size', pages ? '33px' : '22.1px')
    if (pages) await expect(frame.locator('[data-writing-scene="scene-29"] .nv-page')).toHaveCount(0)
    for (const id of ['scene-29', 'scene-10', 'scene-34', 'second']) {
      await page.locator('iframe').evaluate((element, sceneId) => {
        const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
        live.revealWritingPoint({ sceneId, offset: 0, affinity: 'after' })
      }, id)
      const measurePosition = () => frame.locator(`[data-writing-scene="${id}"] p`).first().evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const viewport = element.ownerDocument.getElementById('editor-wrapper')!.getBoundingClientRect()
        return { top: bounds.top - viewport.top, bottom: bounds.bottom - viewport.top, height: viewport.height }
      })
      await expect.poll(async () => {
        const position = await measurePosition()
        return position.top >= -1 && position.top < position.height
      }, { message: `start of ${id} reaches the viewport after deferred layout` }).toBe(true)
      // Once the jump arrives, later layout must not move it out of view.
      await page.waitForTimeout(450)
      const position = await measurePosition()
      expect(position.top, `start of ${id} stays in the viewport`).toBeGreaterThanOrEqual(-1)
      expect(position.top).toBeLessThan(position.height)
    }
  })
}

test('scrolling never paints an unpaginated scene before its paper appears', async ({ page }) => {
  await page.goto(`${url}?long=1&book=1`)
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('.nv-page').first()).toBeVisible()
  const artifacts = await page.locator('iframe').evaluate(async element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    const viewport = live.document.getElementById('editor-wrapper')!
    const artifacts: string[] = []
    for (let step = 0; step < 32; step++) {
      viewport.scrollTop += viewport.clientHeight / 2
      await new Promise<void>(resolve => live.requestAnimationFrame(() => live.requestAnimationFrame(() => resolve())))
      const bounds = viewport.getBoundingClientRect()
      for (const scene of live.document.querySelectorAll<HTMLElement>('[data-writing-scene]')) {
        const rect = scene.getBoundingClientRect()
        if (rect.top < bounds.bottom && rect.bottom > bounds.top && scene.querySelector(':scope > p')) artifacts.push(scene.dataset.writingScene!)
      }
    }
    return artifacts
  })
  expect(artifacts, 'visible scenes must already have their page layout').toEqual([])
})

test('a newer outline jump supersedes the first and manual scrolling releases its anchor', async ({ page }) => {
  await page.goto(`${url}?long=1&book=1`)
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('[data-writing-scene="first"] p').first()).toHaveCSS('font-size', '33px')
  await page.locator('iframe').evaluate(element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    for (const sceneId of ['scene-29', 'scene-10']) live.revealWritingPoint({ sceneId, offset: 0, affinity: 'after' })
  })
  await page.waitForTimeout(450)
  await expect(frame.locator('[data-writing-scene="scene-10"] p').first()).toBeInViewport()
  const stayed = await page.locator('iframe').evaluate(async element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    const viewport = live.document.getElementById('editor-wrapper')!
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true }))
    viewport.scrollTop += 600
    await new Promise(resolve => setTimeout(resolve, 350))
    const before = live.getWritingSceneRoot('scene-10')!.querySelector('p')!.getBoundingClientRect().top
    const last = live.getWritingSceneRoot('scene-36')!
    last.style.minHeight = `${last.offsetHeight + 1000}px`
    await new Promise(resolve => setTimeout(resolve, 100))
    return { before, after: live.getWritingSceneRoot('scene-10')!.querySelector('p')!.getBoundingClientRect().top }
  })
  expect(stayed.before).toBeLessThan(-100)
  expect(Math.abs(stayed.after - stayed.before)).toBeLessThanOrEqual(1)
})

test('a retained reading position survives surrounding scenes finishing layout', async ({ page }) => {
  await page.goto(`${url}?long=1&book=1`)
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('[data-writing-scene="first"] p').first()).toHaveCSS('font-size', '33px')
  const top = await page.locator('iframe').evaluate(async element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    const point = { sceneId: 'scene-29', offset: 50, affinity: 'after' as const }
    live.revealWritingPoint(point, 260)
    await new Promise(resolve => setTimeout(resolve, 450))
    const selection = live.getSelection()!
    const range = selection.getRangeAt(0)
    return range.getBoundingClientRect().top - live.document.getElementById('editor-wrapper')!.getBoundingClientRect().top
  })
  expect(Math.abs(top - 260)).toBeLessThanOrEqual(1)
})

test('scenes prepared ahead of scrolling have the same page groups as fully rendered scenes', async ({ page }) => {
  await page.goto(`${url}?long=1&book=1`)
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('[data-writing-scene="first"] p').first()).toHaveCSS('font-size', '33px')
  const groups = await page.locator('iframe').evaluate(async element => {
    const live = (element as HTMLIFrameElement).contentWindow as unknown as EditorWindow
    const viewport = live.document.getElementById('editor-wrapper')!
    const prepared: { before: number[]; after: number[] }[] = []
    for (let step = 0; step < 18; step++) {
      viewport.scrollTop += viewport.clientHeight / 2
      await new Promise<void>(resolve => live.requestAnimationFrame(() => live.requestAnimationFrame(() => resolve())))
      const bottom = viewport.getBoundingClientRect().bottom
      for (const id of live.writingServiceState().visibleSceneIds) {
        const root = live.getWritingSceneRoot(id)!
        if (root.getBoundingClientRect().top < bottom || !root.querySelector('.nv-page')) continue
        const before = [...root.querySelectorAll('.nv-page')].map(page => page.childNodes.length)
        root.style.contentVisibility = 'visible'
        live.repaginatePageView(root)
        const after = [...root.querySelectorAll('.nv-page')].map(page => page.childNodes.length)
        root.style.removeProperty('content-visibility')
        prepared.push({ before, after })
      }
    }
    return prepared
  })
  expect(groups.length).toBeGreaterThan(0)
  expect(groups.some(group => group.after.length > 1)).toBe(true)
  for (const group of groups) expect(group.before).toEqual(group.after)
})
