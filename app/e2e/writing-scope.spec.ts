import { expect, test } from '@playwright/test'
import { launchApp, seedBook, dismissTour, resizeWindow } from './harness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

test('production host retains typed prose, scope selection and synopsis through collapse', async () => {
  const h = await launchApp('nl-writing-production-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    await resizeWindow(h, 1400, 900)
    const chapter = book.chapters.find(value => value.title === 'Chapter')!
    await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
      await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
      window.novalistStores.shell.getState().setMainView('write')
    }, { chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id })
    await expect(h.page.locator('[data-writing-pane]')).toBeVisible()
    const frame = h.page.frameLocator('iframe[title="editor"]')
    await expect(frame.locator('[data-writing-scene]')).toHaveCount(book.chapters.reduce((count, item) => count + item.scenes.length, 0))
    await expect(frame.locator('[data-scene-title]')).toHaveCount(0)
    await frame.locator(`[data-writing-scene="${chapter.scenes[0].id}"]`).click()
    await h.page.keyboard.type('Production typing persists.')
    const editorFrame = h.page.frames().find(value => value.url().includes('/editor/editor.html'))!
    const readSelection = () => editorFrame.evaluate(() => (window as unknown as EditorWindow).getWritingSelection())
    const typedSelection = await readSelection()
    expect(typedSelection?.focus.sceneId).toBe(chapter.scenes[0].id)
    await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
    await expect(frame.locator('[data-writing-scene]')).toHaveCount(1)
    await expect(frame.locator('[data-writing-scene]')).toContainText('Production typing persists.')
    await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Manuscript', exact: true }).click()
    const root = frame.locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    await expect(root).toContainText('Production typing persists.')
    await expect.poll(readSelection).toEqual(typedSelection)
    const margin = frame.locator('.writing-scene-margin').first()
    await margin.getByRole('button').click()
    await margin.locator('textarea').fill('Synopsis typed before collapse.')
    await margin.getByRole('button').click()
    await margin.getByRole('button').click()
    await expect(margin.locator('textarea')).toHaveValue('Synopsis typed before collapse.')
    await h.page.evaluate(async () => { await window.novalistStores.project.getState().getWritingRegistry()!.flush() })
    const saved = await h.rpc<{ html: string }>('scenes/read', [chapter.guid, chapter.scenes[0].id])
    expect(saved.html).toContain('Production typing persists.')
    await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
    await expect(frame.locator('[data-writing-scene]')).toHaveCount(1)
    await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Manuscript', exact: true }).click()
    await expect.poll(readSelection).toEqual(typedSelection)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('dashboard'))
    await expect(h.page.locator('[data-writing-pane]')).toHaveCount(0)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('write'))
    await expect(root).toContainText('Production typing persists.')
    await root.click()
    await h.page.keyboard.press('Control+z')
    await expect(root).not.toContainText('Production typing persists.')
  } finally { await h.close() }
})

test('two production panes retain independent scopes and share the same live scene document', async () => {
  const h = await launchApp('nl-writing-panes-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    await resizeWindow(h, 1500, 900)
    const chapter = book.chapters.find(value => value.title === 'Chapter')!
    await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
      await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
      const shell = window.novalistStores.shell.getState()
      const first = shell.activePaneId
      shell.setPaneWritingScope(first, 'scene')
      shell.splitActivePane('row')
      const second = window.novalistStores.shell.getState().activePaneId
      await window.novalistStores.project.getState().openSceneIn(second, chapterGuid, sceneId)
    }, { chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id })
    await expect(h.page.locator('[data-writing-pane]')).toHaveCount(2)
    const panes = h.page.locator('[data-writing-pane]')
    await expect(panes.nth(0).locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(panes.nth(1).locator('.writing-scope-segments').getByRole('button', { name: 'Manuscript', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const first = panes.nth(0).frameLocator('iframe').locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    const second = panes.nth(1).frameLocator('iframe').locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    await first.click()
    await h.page.keyboard.type('Shared local document.')
    await expect(second).toContainText('Shared local document.')
    await expect(h.page.locator('iframe[title="editor"]')).toHaveCount(2)
  } finally { await h.close() }
})

test('desktop legacy route preserves an explicit empty run until Show whole manuscript', async () => {
  const h = await launchApp('nl-writing-empty-route-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    await h.page.evaluate(async () => {
      await window.novalistStores.manuscript.getState().compose([])
      window.novalistStores.shell.getState().setMainView('manuscript')
    })
    await expect(h.page.locator('[data-writing-pane]')).toBeVisible()
    await expect(h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Manuscript', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const scenes = h.page.frameLocator('iframe[title="editor"]').locator('[data-writing-scene]')
    await expect(scenes).toHaveCount(0)
    await h.page.getByRole('button', { name: 'Show whole manuscript', exact: true }).click()
    await expect(scenes).toHaveCount(book.chapters.reduce((count, chapter) => count + chapter.scenes.length, 0))
    await expect(h.page.locator('iframe[src*="manuscript-editor"]')).toHaveCount(0)
  } finally { await h.close() }
})
