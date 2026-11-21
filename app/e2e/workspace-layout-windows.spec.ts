import { test, expect, type Page } from '@playwright/test'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'
import type { PaneNode } from '../src/renderer/src/stores/shellTypes'

/**
 * Issue #75: a saved workspace layout records the windows that were undocked
 * when it was saved, and applying it reopens them where they were - replacing
 * whatever undocked windows are open, through the ordinary save-and-close.
 */

const leaves = (node: PaneNode): Extract<PaneNode, { kind: 'leaf' }>[] =>
  node.kind === 'leaf' ? [node] : node.children.flatMap(leaves)

async function paneWindows(h: Harness): Promise<Page[]> {
  const pages: Page[] = []
  for (const page of h.app.windows()) {
    if (page.isClosed()) continue
    if (await page.evaluate(() => new URLSearchParams(location.search).has('pane')).catch(() => false)) pages.push(page)
  }
  return pages
}

async function viewsOf(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const walk = (node: { kind: string; view?: string; children?: unknown[] }): string[] =>
      node.kind === 'leaf' ? [node.view!] : (node.children as typeof node[]).flatMap(walk)
    return walk(window.novalistStores.shell.getState().panes as never)
  })
}

async function openPane(h: Harness, request: Record<string, unknown>): Promise<Page> {
  const opened = h.app.waitForEvent('window')
  await h.page.evaluate((request) => window.novalist.openPaneWindow({
    projectPath: window.novalistStores.project.getState().projectPath, chapterGuid: null, sceneId: null, ...request
  } as never), request)
  const page = await opened
  await expect(page.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
  return page
}

async function setBounds(h: Harness, view: string, offset: { x: number; y: number; width: number; height: number }): Promise<{ x: number; y: number; width: number; height: number }> {
  return h.app.evaluate(({ BrowserWindow, screen }, { view, offset }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => new URL(candidate.webContents.getURL()).searchParams.get('pane') === view)!
    const area = screen.getPrimaryDisplay().workArea
    win.setBounds({ x: area.x + offset.x, y: area.y + offset.y, width: offset.width, height: offset.height })
    return win.getNormalBounds()
  }, { view, offset })
}

async function applyLayout(page: Page, name: string): Promise<void> {
  await page.evaluate(() => window.novalistStores.shell.getState().setLayoutsOpen(true))
  await page.getByRole('dialog', { name: 'Workspace layouts' }).getByRole('button', { name, exact: true }).click()
}

async function saveLayout(page: Page, name: string): Promise<void> {
  await page.evaluate(() => window.novalistStores.shell.getState().setLayoutsOpen(true))
  const dialog = page.getByRole('dialog', { name: 'Workspace layouts' })
  await dialog.getByPlaceholder('Name this layout').fill(name)
  await dialog.getByRole('button', { name: 'Save current', exact: true }).click()
  await expect.poll(() => page.evaluate((name) => JSON.parse(localStorage.getItem('nl.shell.layouts') ?? '[]')
    .some((layout: { name: string; windows?: unknown[] }) => layout.name === name && Array.isArray(layout.windows)), name)).toBe(true)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
}

/** One at a time, the way a writer clicks each window's close button. */
async function closePaneWindowsByHand(h: Harness): Promise<void> {
  for (let open = (await paneWindows(h)).length; open > 0; open--) {
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((win) => new URL(win.webContents.getURL()).searchParams.has('pane'))?.close()
    })
    await expect.poll(async () => (await paneWindows(h)).length, { timeout: 30_000 }).toBe(open - 1)
  }
}

test('a saved layout reopens its undocked windows after a restart, replaces open ones and keeps them on a display', async () => {
  test.setTimeout(240_000)
  let h = await launchApp('nl-layout-windows-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    const chapter = book.chapters[0]
    const later = chapter.scenes[1]
    await h.page.evaluate((scene) => window.novalistStores.project.getState().openScene(scene.chapterGuid, scene.sceneId),
      { chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id })

    await openPane(h, { view: 'codex' })
    // Scene scope, so the scene the window shows is unambiguous.
    const writer = await openPane(h, { view: 'write', chapterGuid: chapter.guid, sceneId: later.id, writingScope: 'scene' })
    await expect.poll(() => writer.evaluate(() => {
      const shell = window.novalistStores.shell.getState()
      return window.novalistStores.project.getState().editors[shell.activePaneId]?.sceneId
    }), { timeout: 30_000 }).toBe(later.id)
    // The writing window is split and its second pane retargeted after it
    // opened: only that window knows, so this is what its report carries.
    await writer.evaluate(() => {
      const shell = window.novalistStores.shell.getState()
      const created = shell.splitPaneById(shell.activePaneId, 'row')!
      window.novalistStores.shell.getState().setPaneView(created, 'timeline')
    })
    const codexBounds = await setBounds(h, 'codex', { x: 40, y: 30, width: 640, height: 700 })
    await expect.poll(() => h.page.evaluate(async () => (await window.novalist.listPaneWindows!())
      .map((entry) => JSON.stringify(entry.content.panes)).join(' ')), { timeout: 15_000 }).toContain('timeline')

    await saveLayout(h.page, 'Two windows')
    await closePaneWindowsByHand(h)
    // A layout saved without windows, used below to check replacement.
    await saveLayout(h.page, 'Main only')
    // A copy of the first layout whose codex window was recorded far off any display.
    await h.page.evaluate(() => {
      const layouts = JSON.parse(localStorage.getItem('nl.shell.layouts')!)
      const copy = JSON.parse(JSON.stringify(layouts.find((layout: { name: string }) => layout.name === 'Two windows')))
      copy.name = 'Off screen'
      copy.windows = copy.windows.filter((entry: { content: { panes: { view?: string } } }) => entry.content.panes.view === 'codex')
      copy.windows[0].placement = { bounds: { x: 50_000, y: 40_000, width: 700, height: 800 }, maximized: false, workArea: { x: 48_000, y: 38_000, width: 1920, height: 1080 } }
      localStorage.setItem('nl.shell.layouts', JSON.stringify([...layouts, copy]))
    })

    const projectPath = (await h.page.evaluate(() => window.novalistStores.project.getState().projectPath))!
    const workDir = h.workDir
    await h.close()
    h = await launchApp('nl-layout-windows-', {}, workDir)
    await h.rpc('project/open', [projectPath])
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().isLoaded)).toBe(true)
    await dismissTour(h.page)
    expect(await paneWindows(h)).toHaveLength(0)

    await applyLayout(h.page, 'Two windows')
    await expect.poll(async () => (await paneWindows(h)).length, { timeout: 30_000 }).toBe(2)
    let pages = await paneWindows(h)
    for (const page of pages) await expect(page.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
    const byView = async (): Promise<Record<string, Page>> => {
      const found: Record<string, Page> = {}
      for (const page of await paneWindows(h)) {
        // A window that has just opened may not have loaded its renderer yet.
        await expect(page.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
        found[(await viewsOf(page)).join('+')] = page
      }
      return found
    }
    let windows = await byView()
    expect(Object.keys(windows).sort()).toEqual(['codex', 'write+timeline'])
    const restoredWriter = windows['write+timeline']
    await expect.poll(() => restoredWriter.evaluate(() => {
      const shell = window.novalistStores.shell.getState()
      const leaf = (function first(node: PaneNode): PaneNode { return node.kind === 'leaf' ? node : first(node.children[0]) })(shell.panes as PaneNode)
      return [(leaf as { writingScope?: string }).writingScope, window.novalistStores.project.getState().editors[leaf.id]?.sceneId]
    }), { timeout: 30_000 }).toEqual(['scene', later.id])
    const bounds = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((win) => new URL(win.webContents.getURL()).searchParams.get('pane') === 'codex')!.getNormalBounds())
    expect(bounds).toEqual(codexBounds)

    // A restored window that reloads comes back as it was, and its saved copy
    // is not replaced by a bare pane.
    await restoredWriter.reload()
    await expect(restoredWriter.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => viewsOf(restoredWriter), { timeout: 30_000 }).toEqual(['write', 'timeline'])
    await restoredWriter.waitForTimeout(600)
    expect(await h.page.evaluate(async () => (await window.novalist.listPaneWindows!())
      .map((entry) => JSON.stringify(entry.content.panes)).join(' '))).toContain('timeline')

    // Applying it again replaces the open windows instead of adding more.
    const previous = await paneWindows(h)
    await applyLayout(h.page, 'Two windows')
    await expect.poll(() => previous.every((page) => page.isClosed()), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => (await paneWindows(h)).length, { timeout: 30_000 }).toBe(2)
    windows = await byView()
    expect(Object.keys(windows).sort()).toEqual(['codex', 'write+timeline'])

    // A layout saved with no undocked windows closes them.
    await applyLayout(h.page, 'Main only')
    await expect.poll(async () => (await paneWindows(h)).length, { timeout: 30_000 }).toBe(0)

    // A window recorded on a display that is gone opens on one that is there.
    await applyLayout(h.page, 'Off screen')
    await expect.poll(async () => (await paneWindows(h)).length, { timeout: 30_000 }).toBe(1)
    const placed = await h.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => new URL(candidate.webContents.getURL()).searchParams.has('pane'))!
      const box = win.getNormalBounds()
      return screen.getAllDisplays().some(({ workArea: a }) => box.x >= a.x && box.y >= a.y &&
        box.x + box.width <= a.x + a.width && box.y + box.height <= a.y + a.height)
    })
    expect(placed).toBe(true)
    pages = await paneWindows(h)
    await expect(pages[0].locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
    expect(await viewsOf(pages[0])).toEqual(['codex'])
  } finally { await h.close().catch(() => {}) }
})

test('a refused close keeps the undocked windows open and says the layout was not applied', async () => {
  const h = await launchApp('nl-layout-windows-refused-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening'] })
    await dismissTour(h.page)
    await saveLayout(h.page, 'Main only')
    const chapter = book.chapters[0]
    const detached = await openPane(h, { view: 'write', chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id })
    await detached.evaluate(() => window.novalistStores.project.setState({
      flushPendingSave: async () => { throw new Error('Simulated save refusal') }
    }))
    // The main window has moved on since the layout was saved; a refused close
    // must leave it where it is too.
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('timeline'))
    await applyLayout(h.page, 'Main only')
    await expect(h.page.getByText('The layout was not applied because an open window could not be closed.', { exact: false })).toBeVisible({ timeout: 30_000 })
    expect(detached.isClosed()).toBe(false)
    expect(await paneWindows(h)).toHaveLength(1)
    expect(await h.page.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('timeline')
  } finally { await h.close().catch(() => {}) }
})
