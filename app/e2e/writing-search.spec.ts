import { expect, test } from '@playwright/test'
import { dismissTour, enterWriting, launchApp, seedBook } from './harness'

test('live and unloaded prose share projection search, exact selection and one replacement undo', async () => {
  const h = await launchApp('nl-writing-search-')
  try {
    const book = await seedBook(h, { Search: ['Visible', 'Unloaded', 'Filtered'] })
    await dismissTour(h.page)
    await enterWriting(h.page)
    const chapter = book.chapters.find(chapter => chapter.title === 'Search')!
    const [first, second, hidden] = chapter.scenes
    const frame = h.page.frameLocator('iframe[title="editor"]')
    await expect(h.page.locator('[data-writing-pane]')).toBeVisible()
    await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
    for (const scene of chapter.scenes) {
      await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
        await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
      }, { chapterGuid: chapter.guid, sceneId: scene.id })
      const surface = frame.locator(`[data-writing-scene="${scene.id}"]`)
      await surface.click()
      await h.page.keyboard.type(scene.id === first.id ? 'Start ' : 'SearchNeedle')
      await h.page.evaluate(async () => { await window.novalistStores.project.getState().getWritingRegistry()!.flush() })
    }
    await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
      await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
    }, { chapterGuid: chapter.guid, sceneId: first.id })
    const prose = frame.locator(`[data-writing-scene="${first.id}"]`)
    await prose.click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type('SearchNeedle')
    await expect(prose).toHaveText('Start SearchNeedle')
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()!.isDirty)).toBe(true)
    await h.page.evaluate(() => window.novalistStores.shell.setState({ findReplaceOpen: true }))
    const dialog = h.page.locator('.findreplace-card')
    await dialog.locator('input').first().fill('SearchNeedle')
    await expect(dialog.locator('.findreplace-scope')).toHaveValue('Projection')
    await dialog.getByRole('button', { name: 'Find', exact: true }).click()
    await expect(dialog.locator('.findreplace-result')).toHaveCount(1)
    await dialog.locator('.findreplace-result').click()
    const editorFrame = h.page.frames().find(frame => frame.url().includes('/editor/editor.html'))!
    expect(await editorFrame.evaluate(() => window.getSelection()?.toString())).toBe('SearchNeedle')
    await dialog.locator('input').nth(1).fill('Changed')
    await dialog.getByRole('button', { name: 'Replace all', exact: false }).click()
    await expect(prose).toContainText('Changed')
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, hidden.id])).html).toContain('SearchNeedle')
    await h.page.evaluate(() => window.novalistStores.shell.setState({ findReplaceOpen: false }))
    await prose.click()
    await h.page.keyboard.press('Control+z')
    await expect(prose).toContainText('SearchNeedle')
    await h.page.evaluate(() => window.novalistStores.shell.setState({ findReplaceOpen: true }))
    await dialog.locator('input').first().fill('SearchNeedle')
    await dialog.locator('.findreplace-scope').selectOption('ActiveBook')
    await dialog.getByRole('button', { name: 'Find', exact: true }).click()
    await expect(dialog.locator('.findreplace-result')).toHaveCount(3)
    await dialog.locator('.findreplace-result', { hasText: 'Unloaded' }).click()
    await expect(frame.locator(`[data-writing-scene="${second.id}"]`)).toContainText('SearchNeedle')
    expect(await editorFrame.evaluate(() => window.getSelection()?.toString())).toBe('SearchNeedle')
  } finally { await h.close() }
})
