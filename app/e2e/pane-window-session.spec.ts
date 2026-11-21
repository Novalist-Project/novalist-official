import { test, expect, type Page } from '@playwright/test'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'

/**
 * The undocked windows a project had open when Novalist closed come back the
 * next time that project is opened - without saving a layout. Windows the
 * writer closed by hand stay closed, and windows that are already open are
 * not opened a second time.
 */

async function paneWindows(h: Harness): Promise<Page[]> {
  const pages: Page[] = []
  for (const page of h.app.windows()) {
    if (page.isClosed()) continue
    if (await page.evaluate(() => new URLSearchParams(location.search).has('pane')).catch(() => false)) pages.push(page)
  }
  return pages
}

async function views(h: Harness): Promise<string[]> {
  const found: string[] = []
  for (const page of await paneWindows(h)) {
    await expect(page.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
    found.push(await page.evaluate(() => {
      const walk = (node: { kind: string; view?: string; children?: unknown[] }): string[] =>
        node.kind === 'leaf' ? [node.view!] : (node.children as typeof node[]).flatMap(walk)
      return walk(window.novalistStores.shell.getState().panes as never).join('+')
    }))
  }
  return found.sort()
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

/** Closes Novalist through its own close path, the way the writer does. */
async function closeNovalist(h: Harness, action: 'quit' | 'close-main'): Promise<void> {
  const closed = Promise.all(h.app.windows().map((page) => page.waitForEvent('close', { timeout: 30_000 })))
  await h.app.evaluate(({ app, BrowserWindow }, action) => {
    const main = BrowserWindow.getAllWindows().find((win) => !new URL(win.webContents.getURL()).searchParams.has('pane'))!
    setImmediate(() => action === 'quit' ? app.quit() : main.close())
  }, action)
  await closed
  await h.close().catch(() => {})
}

async function reopen(prefix: string, workDir: string, projectPath: string): Promise<Harness> {
  const h = await launchApp(prefix, {}, workDir)
  await h.rpc('project/open', [projectPath])
  await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().isLoaded)).toBe(true)
  return h
}

for (const action of ['quit', 'close-main'] as const) {
  test(`undocked windows come back when their project is reopened (${action})`, async () => {
    test.setTimeout(180_000)
    let h = await launchApp('nl-pane-session-')
    try {
      const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
      await dismissTour(h.page)
      const chapter = book.chapters[0]
      await openPane(h, { view: 'codex' })
      await openPane(h, { view: 'write', chapterGuid: chapter.guid, sceneId: chapter.scenes[1].id, writingScope: 'scene' })
      const bounds = await h.app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => new URL(candidate.webContents.getURL()).searchParams.get('pane') === 'codex')!
        const area = screen.getPrimaryDisplay().workArea
        win.setBounds({ x: area.x + 60, y: area.y + 50, width: 600, height: 650 })
        return win.getNormalBounds()
      })
      const projectPath = (await h.page.evaluate(() => window.novalistStores.project.getState().projectPath))!
      const workDir = h.workDir
      await closeNovalist(h, action)

      h = await reopen('nl-pane-session-', workDir, projectPath)
      await expect.poll(async () => (await paneWindows(h)).length, { timeout: 30_000 }).toBe(2)
      expect(await views(h)).toEqual(['codex', 'write'])
      const writer = (await paneWindows(h))[(await Promise.all((await paneWindows(h)).map((page) =>
        page.evaluate(() => window.novalistStores.shell.getState().mainView)))).indexOf('write')]
      await expect.poll(() => writer.evaluate(() => {
        const shell = window.novalistStores.shell.getState()
        return window.novalistStores.project.getState().editors[shell.activePaneId]?.sceneId
      }), { timeout: 30_000 }).toBe(chapter.scenes[1].id)
      expect(await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find((win) => new URL(win.webContents.getURL()).searchParams.get('pane') === 'codex')!.getNormalBounds())).toEqual(bounds)

      // Closing and reopening the project in the same session: the windows
      // stayed open and followed it, so none is opened a second time.
      await h.page.evaluate(() => window.novalistStores.project.getState().closeProject())
      await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().isLoaded)).toBe(false)
      await h.rpc('project/open', [projectPath])
      await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().isLoaded)).toBe(true)
      await h.page.waitForTimeout(1500)
      expect(await paneWindows(h)).toHaveLength(2)
    } finally { await h.close().catch(() => {}) }
  })
}

test('undocked windows closed by hand do not come back', async () => {
  test.setTimeout(180_000)
  let h = await launchApp('nl-pane-session-hand-')
  try {
    await seedBook(h, { Chapter: ['Opening'] })
    await dismissTour(h.page)
    await openPane(h, { view: 'codex' })
    await openPane(h, { view: 'maps' })
    for (const [index, view] of ['codex', 'maps'].entries()) {
      await h.app.evaluate(({ BrowserWindow }, view) => {
        BrowserWindow.getAllWindows().find((win) => new URL(win.webContents.getURL()).searchParams.get('pane') === view)!.close()
      }, view)
      await expect.poll(async () => (await paneWindows(h)).length, { timeout: 30_000 }).toBe(1 - index)
    }
    const projectPath = (await h.page.evaluate(() => window.novalistStores.project.getState().projectPath))!
    const workDir = h.workDir
    await closeNovalist(h, 'quit')

    h = await reopen('nl-pane-session-hand-', workDir, projectPath)
    await h.page.waitForTimeout(3000)
    expect(await paneWindows(h)).toHaveLength(0)
  } finally { await h.close().catch(() => {}) }
})
