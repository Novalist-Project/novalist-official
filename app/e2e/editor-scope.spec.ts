import { test, expect } from '@playwright/test'
import { dismissTour, launchApp, seedBook } from './harness'

/**
 * The writing view can hold one scene, the open scene's chapter, or the whole
 * manuscript. In the two stacked scopes every scene is its own editor, so a
 * writer types from one scene into the next and each scene still saves on its
 * own.
 */
test('chapter and manuscript scopes stack one editor per scene', async () => {
  test.setTimeout(120_000)
  const h = await launchApp('nl-editor-scope-')
  try {
    const book = await seedBook(h, { One: ['Opening', 'Middle', 'End'], Two: ['Later'] })
    const [one, two] = book.chapters
    await dismissTour(h.page)
    await h.page.evaluate(([guid, id]) => window.novalistStores.project.getState().openScene(guid, id), [one.guid, one.scenes[0].id])
    await expect(h.page.locator('iframe[title="editor"]')).toHaveCount(1)

    // The switch above the editor changes the setting, at the scope being edited.
    await h.page.getByRole('radio', { name: 'Chapter' }).click()
    await expect
      .poll(() => h.page.evaluate(() => window.novalistStores.settings.getState().view?.effective.editorScope))
      .toBe('chapter')
    const rows = h.page.locator('.stacked-editor-scene')
    await expect(rows).toHaveCount(3)
    await expect(h.page.locator('iframe.editor-frame-stacked')).toHaveCount(3)
    await expect(h.page.locator('iframe.editor-frame-stacked').nth(1)).toHaveAttribute('title', 'Scene editor: Middle')
    await expect(h.page.locator('.stacked-editor-column').nth(1)).toContainText('ONE – MIDDLE', { ignoreCase: true })

    // Typing into the second scene writes the second scene, not the opened one.
    const middle = h.page.frameLocator('[data-stacked-scene="' + one.scenes[1].id + '"] iframe').locator('#editor')
    await middle.click()
    await middle.fill('Written in the stack.')
    await expect
      .poll(() => h.page.evaluate(() => window.novalistStores.project.getState().openSceneId))
      .toBe(one.scenes[1].id)
    await h.page.evaluate(() => window.novalistStores.project.getState().flushPendingSave())
    await expect
      .poll(async () => (await h.rpc<{ html: string }>('scenes/read', [one.guid, one.scenes[1].id])).html)
      .toContain('Written in the stack.')
    expect((await h.rpc<{ html: string }>('scenes/read', [one.guid, one.scenes[0].id])).html).not.toContain('Written in the stack.')

    // The arrow keys carry the caret over the edge of a scene into the next.
    await middle.press('End')
    await middle.press('ArrowDown')
    await expect
      .poll(() => h.page.evaluate(() => window.novalistStores.project.getState().openSceneId))
      .toBe(one.scenes[2].id)

    // The synopsis beside the prose is the scene's synopsis.
    const synopsis = h.page.locator('.stacked-editor-synopsis').first()
    await synopsis.fill('Where it begins.')
    await synopsis.blur()
    await expect
      .poll(() => h.page.evaluate((id) => window.novalistStores.project.getState().chapters
        .flatMap((chapter) => chapter.scenes).find((scene) => scene.id === id)?.synopsis, one.scenes[0].id))
      .toBe('Where it begins.')

    // A new scene lands straight after the one it was asked for under.
    await h.page.locator('.stacked-editor-new').first().click()
    await expect(rows).toHaveCount(4)
    const titles = await h.page.evaluate((guid) => window.novalistStores.project.getState().chapters
      .find((chapter) => chapter.guid === guid)!.scenes.map((scene) => scene.title), one.guid)
    expect(titles).toEqual(['Opening', 'Scene 2', 'Middle', 'End'])

    // The manuscript scope holds every chapter, each under its heading.
    await h.page.getByRole('radio', { name: 'Manuscript' }).click()
    await expect(rows).toHaveCount(5)
    await expect(h.page.locator('.stacked-editor-chapter')).toHaveText(['One', 'Two'])

    // Opening a scene that is already in the stack scrolls to it instead of
    // loading it a second time.
    await h.page.evaluate(([guid, id]) => window.novalistStores.project.getState().openScene(guid, id), [two.guid, two.scenes[0].id])
    await expect
      .poll(() => h.page.evaluate(() => window.novalistStores.project.getState().openSceneId))
      .toBe(two.scenes[0].id)
    const holders = await h.page.evaluate((id) => Object.values(window.novalistStores.project.getState().editors)
      .filter((editor) => editor.sceneId === id).length, two.scenes[0].id)
    expect(holders).toBe(1)

    // Words typed just before a scene's editor is let go are still written.
    const later = h.page.frameLocator(`[data-stacked-scene="${two.scenes[0].id}"] iframe`).locator('#editor')
    await later.click()
    await later.pressSequentially('Last words.')
    await h.page.getByRole('radio', { name: 'Scene' }).click()
    await expect
      .poll(async () => (await h.rpc<{ html: string }>('scenes/read', [two.guid, two.scenes[0].id])).html)
      .toContain('Last words.')

    // Back to one scene: a single editor and no stacked entries left behind.
    await expect(h.page.locator('iframe[title="editor"]')).toHaveCount(1)
    await expect
      .poll(() => h.page.evaluate(() => Object.keys(window.novalistStores.project.getState().editors)
        .filter((id) => id.includes('~')).length))
      .toBe(0)
  } finally {
    await h.close()
  }
})
