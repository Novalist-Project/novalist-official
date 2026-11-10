import { expect, test } from '@playwright/test'
import { dismissTour, launchApp, seedBook } from './harness'

test('a mounted Structure board reflects metadata edited in a detached writing window', async () => {
  const h = await launchApp('nl-planning-window-refresh-')
  try {
    const book = await seedBook(h, { Original: ['Opening'] }, 'Planning metadata', false)
    const chapter = book.chapters[0]
    await dismissTour(h.page)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('structure'))
    const board = h.page.locator('.structure-board')
    await expect(board).toBeVisible()
    await board.evaluate(element => element.setAttribute('data-test-retained', 'original'))
    const opened = h.app.waitForEvent('window')
    await h.page.evaluate(async chapter => {
      const project = window.novalistStores.project.getState()
      await window.novalist.openPaneWindow({ view: 'write', projectPath: project.projectPath,
        bookId: project.activeBookId, draftId: project.activeDraftId,
        chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id, writingScope: 'scene' })
    }, chapter)
    const detached = await opened
    await expect(detached.frameLocator('.editor-frame').locator('[data-writing-scene]')).toHaveCount(1)
    await detached.evaluate(guid => window.novalistStores.project.getState().renameChapter(guid, 'Renamed in another window'), chapter.guid)
    await expect(board.getByRole('button', { name: 'Renamed in another window', exact: true })).toBeVisible()
    await detached.evaluate(guid => window.novalistRpc.request('project/setChapterDescription', [guid, 'Summary from another window']), chapter.guid)
    await expect(board).toContainText('Summary from another window')
    await expect(board).toHaveAttribute('data-test-retained', 'original')
    expect(await h.page.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('structure')
  } finally { await h.close() }
})
