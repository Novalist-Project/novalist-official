import { expect, test } from '@playwright/test'
import { dismissTour, launchApp, resizeWindow, seedBook } from './harness'

test('narrow writing keeps synopsis in a bounded popover and preserves word counts when hidden', async () => {
  const h = await launchApp('nl-writing-synopsis-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening'] })
    await dismissTour(h.page)
    await resizeWindow(h, 700, 800)
    const chapter = book.chapters.find(value => value.title === 'Chapter')!
    await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
      await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
    }, { chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id })
    const frame = h.page.frameLocator('iframe[title="editor"]')
    await expect(frame.locator('body')).toHaveClass(/writing-narrow/)
    const margin = frame.locator('.writing-scene-margin').first()
    await expect(margin.getByRole('button', { name: 'Synopsis', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await margin.getByRole('button', { name: 'Synopsis', exact: true }).click()
    const popover = frame.locator('.writing-synopsis-popover')
    await expect(popover).toBeVisible()
    await popover.locator('textarea').fill('A compact outline of this scene.')
    const withinViewport = await popover.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const viewport = element.ownerDocument.documentElement
      return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= viewport.clientWidth && bounds.bottom <= viewport.clientHeight
    })
    expect(withinViewport).toBe(true)
    await popover.getByRole('button', { name: 'Close', exact: true }).click()
    await margin.getByRole('button', { name: 'Synopsis', exact: true }).click()
    await expect(popover.locator('textarea')).toHaveValue('A compact outline of this scene.')
    await h.page.locator('.writing-scope-toolbar').getByRole('button', { name: /synopsis/i }).click()
    await expect(margin.getByRole('button', { name: 'Synopsis', exact: true })).toHaveCount(0)
    await expect(margin.locator('small')).toBeVisible()
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, chapter.scenes[0].id])).html).not.toContain('compact outline')
  } finally { await h.close() }
})
