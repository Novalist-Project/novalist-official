import { expect, test } from '@playwright/test'
import { launchApp, seedBook, dismissTour, resizeWindow, type Book, type Harness } from './harness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

async function openWriting(h: Harness, chapterGuid: string, sceneId: string): Promise<void> {
  await dismissTour(h.page)
  await resizeWindow(h, 1500, 900)
  await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
    await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
  }, { chapterGuid, sceneId })
  await expect(h.page.locator('[data-writing-pane]')).toBeVisible()
  await expect(h.page.frameLocator('iframe[title="editor"]').locator(`[data-writing-scene="${sceneId}"]`)).toBeVisible()
}

test('caret split and structural undo retain prose history across workspace remounts', async () => {
  const h = await launchApp('nl-writing-structure-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    const chapter = book.chapters.find(value => value.title === 'Chapter')!
    const first = chapter.scenes[0]
    await openWriting(h, chapter.guid, first.id)
    const frame = h.page.frameLocator('iframe[title="editor"]')
    const source = frame.locator(`[data-writing-scene="${first.id}"]`)
    await source.click()
    await h.page.keyboard.type('Alpha beta.')
    await h.page.evaluate(async () => { await window.novalistStores.project.getState().getWritingRegistry()!.flush() })
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' Tail')
    const runtime = h.page.frames().find(value => value.url().includes('/editor/editor.html'))!
    await runtime.evaluate(sceneId => {
      const editor = window as unknown as EditorWindow
      const caret = { sceneId, offset: 6, affinity: 'after' as const }
      editor.restoreWritingSelection({ anchor: caret, focus: caret })
      editor.requestWritingStructure('sceneBreak')
    }, first.id)
    await expect.poll(async () => {
      const errors = await h.page.locator('.writing-structure-error').allTextContents()
      return errors.length ? errors : source.textContent().catch(() => null)
    }).toBe('Alpha ')
    expect((await h.rpc<Book>('project/getState')).chapters.find(value => value.guid === chapter.guid)!.scenes).toHaveLength(3)
    await source.click()
    await h.page.keyboard.press('Control+z')
    await expect(source).toHaveText('Alpha beta. Tail')
    expect((await h.rpc<Book>('project/getState')).chapters.find(value => value.guid === chapter.guid)!.scenes).toHaveLength(2)
    await source.click()
    await h.page.keyboard.press('Control+z')
    await expect(source).toHaveText('Alpha beta.')
    await expect(frame.locator('[data-scene-title]')).toHaveCount(0)
  } finally { await h.close() }
})

test('chapter heading splits at the caret and carries the remaining scenes into the named chapter', async () => {
  const h = await launchApp('nl-writing-heading-')
  try {
    const book = await seedBook(h, { Original: ['First', 'Second'], Empty: [], Later: ['Last'] })
    const chapter = book.chapters.find(value => value.title === 'Original')!
    await openWriting(h, chapter.guid, chapter.scenes[0].id)
    const frame = h.page.frameLocator('iframe[title="editor"]')
    await expect(frame.locator('.writing-empty-chapter')).toContainText('Empty')
    const source = frame.locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    await source.click()
    await h.page.keyboard.type('Left Right')
    const runtime = h.page.frames().find(value => value.url().includes('/editor/editor.html'))!
    await runtime.evaluate(sceneId => {
      const editor = window as unknown as EditorWindow
      const caret = { sceneId, offset: 5, affinity: 'after' as const }
      editor.restoreWritingSelection({ anchor: caret, focus: caret })
      editor.requestWritingStructure('chapterHeading')
    }, chapter.scenes[0].id)
    const dialog = h.page.getByRole('dialog', { name: /Insert chapter/ })
    await dialog.locator('input').fill('The turn')
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(frame.locator('.writing-chapter-heading')).toContainText(['Original', 'The turn', 'Empty', 'Later'])
    await expect(source).toHaveText('Left ')
    const current = await h.rpc<Book>('project/getState')
    const inserted = current.chapters.find(value => value.title === 'The turn')!
    expect(inserted.scenes).toHaveLength(2)
    expect(inserted.scenes[1].id).toBe(chapter.scenes[1].id)
    await expect(frame.locator(`[data-writing-scene="${inserted.scenes[0].id}"]`)).toHaveText('Right')
    expect(await h.page.evaluate(() => window.novalistStores.project.getState().openSceneId)).toBe(inserted.scenes[0].id)
    const following = frame.locator('.writing-scene-chrome').filter({ has: frame.locator('.writing-chapter-heading h2', { hasText: 'Later' }) })
    await expect(following.getByRole('button', { name: 'Insert chapter' })).toBeVisible()
  } finally { await h.close() }
})

test('end insertion creates a named chapter and one blank scene without needing a caret', async () => {
  const h = await launchApp('nl-writing-chapter-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening'] })
    const chapter = book.chapters.find(value => value.title === 'Chapter')!
    await openWriting(h, chapter.guid, chapter.scenes[0].id)
    const frame = h.page.frameLocator('iframe[title="editor"]')
    await frame.locator('.writing-end').getByRole('button', { name: 'Insert chapter' }).click()
    const dialog = h.page.getByRole('dialog', { name: /Insert chapter/ })
    await dialog.locator('input').fill('After the storm')
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect.poll(async () => {
      const errors = await h.page.locator('.writing-structure-error').allTextContents()
      return errors.length ? errors : frame.locator('.writing-chapter-heading h2').last().textContent().catch(() => null)
    }).toBe('After the storm')
    const after = (await h.rpc<Book>('project/getState')).chapters.at(-1)!
    expect(after.scenes).toHaveLength(1)
    await expect(frame.locator(`[data-writing-scene="${after.scenes[0].id}"]`)).toHaveText('')
    await expect(frame.locator('.writing-chapter-heading').last()).toContainText('After the storm')
  } finally { await h.close() }
})
