import { test, expect } from '@playwright/test'
import { dismissTour, launchApp, seedBook } from './harness'
import type { EditingSceneClaim } from '../src/renderer/src/stores/projectTypes'

declare global {
  interface Window { editingClaimProbe: { reports: EditingSceneClaim[][]; blockWrites: boolean } }
}

test('canonical native edits protect offscreen scenes through acknowledged backend editing claims', async () => {
  const h = await launchApp('novalist-editing-claims-')
  try {
    const book = await seedBook(h, { Chapter: ['First', 'Second'] }, 'Editing guard fixture', false)
    const chapter = book.chapters[0], [first, second] = chapter.scenes
    await h.rpc('scenes/write', [chapter.guid, first.id, '<p>Original.</p>', 'Original.'])
    await h.rpc('scenes/write', [chapter.guid, second.id, '<p>Other scene.</p>', 'Other scene.'])
    await dismissTour(h.page)
    await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
      const rpc = window.novalistRpc, original = rpc.request.bind(rpc)
      const probe = { reports: [] as EditingSceneClaim[][], blockWrites: true }
      window.editingClaimProbe = probe
      rpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'writing/commit' && probe.blockWrites) throw new Error('The guard fixture is retaining unsaved edits.')
        const result = await original<T>(method, params)
        if (method === 'scenes/setEditingMany') probe.reports.push(structuredClone((params as [EditingSceneClaim[]])[0]))
        if (method === 'scenes/setEditing') {
          const [chapterGuid, sceneId, dirty] = params as [string | null, string | null, boolean]
          probe.reports.push(chapterGuid && sceneId ? [{ chapterGuid, sceneId, dirty }] : [])
        }
        return result
      }
      const shell = window.novalistStores.shell.getState()
      shell.setPaneWritingScope(shell.activePaneId, 'scene')
      await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
    }, { chapterGuid: chapter.guid, sceneId: first.id })
    const frame = h.page.frameLocator('.editor-frame')
    const firstScene = frame.locator('[data-writing-scene="' + first.id + '"]')
    await expect(firstScene).toHaveText('Original.')
    await firstScene.click()
    await expect.poll(() => h.page.evaluate(sceneId => window.editingClaimProbe.reports.some(report =>
      report.some(claim => claim.sceneId === sceneId && !claim.dirty)), first.id)).toBe(true)
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' Unsaved.')
    await expect(firstScene).toHaveText('Original. Unsaved.')
    await expect.poll(() => h.page.evaluate(sceneId => window.editingClaimProbe.reports.at(-1)?.some(claim =>
      claim.sceneId === sceneId && claim.dirty), first.id)).toBe(true)
    expect(await h.page.evaluate(() => window.novalistStores.project.getState().editors[
      window.novalistStores.project.getState().activeEditorPaneId!].isDirty)).toBe(false)

    await h.page.evaluate(({ chapterGuid, sceneId }) => window.novalistStores.project.getState().openScene(chapterGuid, sceneId),
      { chapterGuid: chapter.guid, sceneId: second.id })
    const secondScene = frame.locator('[data-writing-scene="' + second.id + '"]')
    await expect(secondScene).toHaveText('Other scene.')
    await secondScene.click()
    await expect.poll(() => h.page.evaluate(() => window.editingClaimProbe.reports.at(-1))).toEqual([
      { chapterGuid: chapter.guid, sceneId: first.id, dirty: true },
      { chapterGuid: chapter.guid, sceneId: second.id, dirty: false }
    ].sort((a, b) => a.sceneId.localeCompare(b.sceneId)))
    await h.page.evaluate(async () => {
      window.editingClaimProbe.blockWrites = false
      const project = window.novalistStores.project.getState()
      await project.flushPane(project.activeEditorPaneId!)
    })
    await expect.poll(() => h.page.evaluate(() => window.editingClaimProbe.reports.at(-1))).toEqual([
      { chapterGuid: chapter.guid, sceneId: second.id, dirty: false }
    ])
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, first.id])).html).toContain('Original. Unsaved.')
  } finally {
    if (!h.page.isClosed()) await h.page.evaluate(() => { if (window.editingClaimProbe) window.editingClaimProbe.blockWrites = false })
    await h.close()
  }
})
