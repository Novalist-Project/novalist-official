import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'
import type { PaneNode } from '../src/renderer/src/stores/shellTypes'

/**
 * The main window's own split comes back when its project is reopened: after a
 * restart and after switching to another project and back. An unsplit window
 * opens as it always did, and a recorded scene that is gone does not stop the
 * rest of the split coming back.
 */

type Shape = { direction: string | null; sizes: number[]; views: string[]; activeIndex: number; scenes: (string | null)[] }

async function shape(h: Harness): Promise<Shape> {
  return h.page.evaluate(() => {
    const shell = window.novalistStores.shell.getState()
    const leaves: { id: string; view: string }[] = []
    const walk = (node: PaneNode): void => { if (node.kind === 'leaf') leaves.push(node); else node.children.forEach(walk) }
    walk(shell.panes as PaneNode)
    const root = shell.panes as PaneNode
    const editors = window.novalistStores.project.getState().editors
    return {
      direction: root.kind === 'split' ? root.direction : null,
      sizes: root.kind === 'split' ? root.sizes.map((size) => Math.round(size)) : [],
      views: leaves.map((leaf) => leaf.view),
      activeIndex: leaves.findIndex((leaf) => leaf.id === shell.activePaneId),
      scenes: leaves.map((leaf) => editors[leaf.id]?.sceneId ?? null)
    }
  })
}

/** Editor with a scene on the left, the Codex on the right and active, 65/35. */
async function splitMainWindow(h: Harness, sceneId: string, chapterGuid: string): Promise<void> {
  await h.page.evaluate(({ chapterGuid, sceneId }) => window.novalistStores.project.getState().openScene(chapterGuid, sceneId), { chapterGuid, sceneId })
  await h.page.evaluate(() => {
    const shell = window.novalistStores.shell.getState()
    const created = shell.splitPaneById(shell.activePaneId, 'row')!
    window.novalistStores.shell.getState().setPaneView(created, 'codex')
    window.novalistStores.shell.getState().setActivePane(created)
    const root = window.novalistStores.shell.getState().panes as PaneNode
    window.novalistStores.shell.getState().setPaneSizes(root.id, [65, 35])
  })
  await expect.poll(() => shape(h)).toEqual({ direction: 'row', sizes: [65, 35], views: ['write', 'codex'], activeIndex: 1, scenes: [sceneId, null] })
  // The arrangement is recorded after a short pause.
  await h.page.waitForTimeout(800)
}

async function closeNovalist(h: Harness): Promise<void> {
  const closed = Promise.all(h.app.windows().map((page) => page.waitForEvent('close', { timeout: 30_000 })))
  await h.app.evaluate(({ app }) => { setImmediate(() => app.quit()) })
  await closed
  await h.close().catch(() => {})
}

async function open(h: Harness, projectPath: string): Promise<void> {
  await h.page.evaluate(async (path) => {
    const state = await window.novalistRpc.request('project/open', [path])
    window.novalistStores.project.getState().applyState(state as never)
  }, projectPath)
  await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().projectPath)).toBe(projectPath)
}

test('the main window\'s split comes back after a restart, with its views, scene and active pane', async () => {
  test.setTimeout(180_000)
  let h = await launchApp('nl-main-split-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    const chapter = book.chapters[0]
    await splitMainWindow(h, chapter.scenes[1].id, chapter.guid)
    const projectPath = (await h.page.evaluate(() => window.novalistStores.project.getState().projectPath))!
    const workDir = h.workDir
    await closeNovalist(h)

    h = await launchApp('nl-main-split-', {}, workDir)
    await open(h, projectPath)
    await expect.poll(() => shape(h), { timeout: 30_000 })
      .toEqual({ direction: 'row', sizes: [65, 35], views: ['write', 'codex'], activeIndex: 1, scenes: [chapter.scenes[1].id, null] })
    expect(await h.page.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('codex')
    await expect(h.page.locator('.pane-header')).toHaveCount(2)
    expect(h.app.windows()).toHaveLength(1)
  } finally { await h.close().catch(() => {}) }
})

test('the split comes back after switching to another project and back', async () => {
  test.setTimeout(180_000)
  const h = await launchApp('nl-main-split-switch-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    const chapter = book.chapters[0]
    const first = (await h.page.evaluate(() => window.novalistStores.project.getState().projectPath))!
    await splitMainWindow(h, chapter.scenes[0].id, chapter.guid)

    // Another project, arranged as a single pane.
    await h.page.evaluate(async (dir) => {
      const state = await window.novalistRpc.request('project/create', [dir, 'Other', 'Book One'])
      window.novalistStores.project.getState().applyState(state as never)
    }, h.workDir)
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().projectPath)).not.toBe(first)
    await h.page.evaluate(() => window.novalistStores.shell.getState().resetPanes())
    await expect.poll(async () => (await shape(h)).views.length).toBe(1)
    await h.page.waitForTimeout(800)

    await open(h, first)
    await expect.poll(() => shape(h), { timeout: 30_000 })
      .toEqual({ direction: 'row', sizes: [65, 35], views: ['write', 'codex'], activeIndex: 1, scenes: [chapter.scenes[0].id, null] })
  } finally { await h.close().catch(() => {}) }
})

test('an unsplit main window opens as before, on the Dashboard', async () => {
  test.setTimeout(180_000)
  let h = await launchApp('nl-main-unsplit-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening'] })
    await dismissTour(h.page)
    await h.page.evaluate((chapter) => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), book.chapters[0])
    await h.page.waitForTimeout(800)
    const projectPath = (await h.page.evaluate(() => window.novalistStores.project.getState().projectPath))!
    const workDir = h.workDir
    await closeNovalist(h)

    h = await launchApp('nl-main-unsplit-', {}, workDir)
    await open(h, projectPath)
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('dashboard')
    await h.page.waitForTimeout(1500)
    expect((await shape(h)).views).toEqual(['dashboard'])
    await expect(h.page.locator('.pane-header')).toHaveCount(0)
  } finally { await h.close().catch(() => {}) }
})

test('a recorded scene that no longer exists leaves its pane empty and the rest of the split intact', async () => {
  test.setTimeout(180_000)
  let h = await launchApp('nl-main-split-gone-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    const chapter = book.chapters[0]
    await splitMainWindow(h, chapter.scenes[1].id, chapter.guid)
    const projectPath = (await h.page.evaluate(() => window.novalistStores.project.getState().projectPath))!
    const workDir = h.workDir
    await closeNovalist(h)

    // Stands in for a scene deleted on another machine or outside Novalist:
    // the recorded id no longer names a scene in the project.
    const file = join(workDir, 'profile', 'pane-windows.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.projects[0].main.scenes[0].sceneId = 'deleted-scene'
    writeFileSync(file, JSON.stringify(stored))

    h = await launchApp('nl-main-split-gone-', {}, workDir)
    await open(h, projectPath)
    await expect.poll(async () => (await shape(h)).views, { timeout: 30_000 }).toEqual(['write', 'codex'])
    const restored = await shape(h)
    expect(restored.scenes).toEqual([null, null])
    expect(restored.activeIndex).toBe(1)
    await expect(h.page.locator('.pane-header')).toHaveCount(2)
  } finally { await h.close().catch(() => {}) }
})
