import { test, expect } from '@playwright/test'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'
import { replaceWritingScene } from './writingTestActions'

async function splitScenes(h: Harness, chapterGuid: string, sceneIds: string[]): Promise<string[]> {
  return h.page.evaluate(async ({ chapterGuid, sceneIds }) => {
    const shell = window.novalistStores.shell.getState()
    shell.setMainView('write')
    const left = window.novalistStores.shell.getState().activePaneId
    shell.setPaneWritingScope(left, 'scene')
    await window.novalistStores.project.getState().openSceneIn(left, chapterGuid, sceneIds[0])
    shell.splitActivePane('row')
    const right = window.novalistStores.shell.getState().activePaneId
    shell.setPaneWritingScope(right, 'scene')
    await window.novalistStores.project.getState().openSceneIn(right, chapterGuid, sceneIds[1])
    return [left, right]
  }, { chapterGuid, sceneIds })
}

for (const savedFirst of [0, 1]) {
  test(`both split panes retain the same canonical edits when pane ${savedFirst + 1} saves first`, async () => {
    const h = await launchApp('nl-audit-split-ownership-')
    try {
      const book = await seedBook(h, { Chapter: ['Shared scene'] }, 'Spec', false)
      await dismissTour(h.page)
      const chapter = book.chapters[0]
      const scene = chapter.scenes[0]
      await h.rpc('scenes/write', [chapter.guid, scene.id, '<p>Original</p>', 'Original'])
      const panes = await splitScenes(h, chapter.guid, [scene.id, scene.id])
      const editors = [0, 1].map(index => h.page.locator('.pane-leaf').nth(index).frameLocator('.editor-frame').locator(`[data-writing-scene="${scene.id}"]`))
      for (const editor of editors) await expect(editor).toHaveText('Original')
      await editors[0].click()
      await h.page.keyboard.press('End')
      await h.page.keyboard.type(' Left')
      await expect(editors[1]).toHaveText('Original Left')
      await editors[1].click()
      await h.page.keyboard.press('End')
      await h.page.keyboard.type(' Right')
      for (const editor of editors) await expect(editor).toHaveText('Original Left Right')
      await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()?.isDirty)).toBe(true)
      await h.page.evaluate(pane => window.novalistStores.project.getState().flushPane(pane), panes[savedFirst])
      expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, scene.id])).html).toContain('Original Left Right')
      await h.page.evaluate(pane => window.novalistStores.project.getState().flushPane(pane), panes[1 - savedFirst])
      await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
      for (const editor of editors) await expect(editor).toHaveText('Original Left Right')
      expect(await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()?.isDirty)).toBe(false)
      expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, scene.id])).html).toContain('Original Left Right')
    } finally { await h.close() }
  })
}

test('saving a split pane preserves its original buffer when saving conflicts', async () => {
  const h = await launchApp('nl-audit-move-conflict-')
  try {
    const book = await seedBook(h, { Chapter: ['Source', 'Destination'] }, 'Spec', false)
    await dismissTour(h.page)
    const chapter = book.chapters[0]
    const [source, destination] = chapter.scenes
    await h.rpc('scenes/write', [chapter.guid, source.id, '<p>Original source</p>', 'Original source'])
    await h.rpc('scenes/write', [chapter.guid, destination.id, '<p>Destination prose</p>', 'Destination prose'])
    const panes = await splitScenes(h, chapter.guid, [source.id, destination.id])
    const left = h.page.locator('.pane-leaf').nth(0)
    const editor = left.frameLocator('.editor-frame').locator(`[data-writing-scene="${source.id}"]`)
    await expect(editor).toHaveText('Original source')
    await replaceWritingScene(h.page, source.id, '<p>Unsaved source must stay here</p>')
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()?.isDirty)).toBe(true)
    await h.rpc('scenes/write', [chapter.guid, source.id, '<p>Saved elsewhere</p>', 'Saved elsewhere'])
    await expect(h.page.evaluate(pane => window.novalistStores.project.getState().flushPane(pane), panes[0])).rejects.toThrow('writing.conflict')
    await expect(h.page.locator('.scene-conflict-card')).toBeVisible()
    await expect(h.page.locator('.pane-leaf')).toHaveCount(2)
    await expect(editor).toHaveText('Unsaved source must stay here')
    await expect(h.page.locator('.pane-leaf').nth(1).frameLocator('.editor-frame').locator(`[data-writing-scene="${destination.id}"]`)).toHaveText('Destination prose')
    const state = await h.page.evaluate(panes => panes.map(pane => {
      const editor = window.novalistStores.project.getState().editors[pane]
      return editor.sceneId
    }), panes)
    expect(state).toEqual([source.id, destination.id])
    expect(await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()?.isDirty)).toBe(true)
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, source.id])).html).toBe('<p>Saved elsewhere</p>')
  } finally { await h.close() }
})
