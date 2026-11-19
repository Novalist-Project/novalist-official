import { test, expect, _electron as electron } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { copyProject } from './copyProject'
import { evaluateWhenReady, waitForAppReady } from './appReady'
import { REAL_PROJECT } from './realProject'
import { closeTestApp, launchApp, seedBook, dismissTour, enterWriting } from './harness'

/**
 * A pane torn out into its own window, and two panes side by side.
 *
 * The Codex on a second monitor while the manuscript stays where it is. What
 * matters, and what no unit test can reach, is that the second window is a
 * real one: its own connection to the same backend, showing the real view
 * rather than a picture of it. A window that opens blank, or opens showing the
 * main shell again, would look fine in every other test - as would a split that
 * puts the same scene in both halves.
 */

test('a pane opens in its own window and shows the real view', async () => {
  test.skip(!existsSync(join(REAL_PROJECT, '.novalist')), 'real project not available')
  test.setTimeout(120_000)

  const workDir = mkdtempSync(join(tmpdir(), 'nl-popout-'))
  const projectCopy = join(workDir, 'project')
  copyProject(REAL_PROJECT, projectCopy)
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')
  ) as Record<string, string>
  env.NOVALIST_SETTINGS_DIR = join(workDir, 'settings')
  env.NOVALIST_NO_SPLASH = '1'

  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${join(env.NOVALIST_SETTINGS_DIR, 'profile')}`], env })
  const page = await app.firstWindow()
  await waitForAppReady(page)
  await evaluateWhenReady(page, async (root) => {
    const state = await window.novalistRpc.request('project/open', [root])
    window.novalistStores.project.getState().applyState(state as never)
  }, projectCopy)

  // Tear the Codex out.
  await page.evaluate(() => window.novalistStores.shell.getState().setMainView('codex'))
  await page.waitForTimeout(600)
  const opened = app.waitForEvent('window')
  await page.evaluate(() =>
    window.novalist.openPaneWindow({
      view: 'codex',
      projectPath: window.novalistStores.project.getState().projectPath,
      chapterGuid: null,
      sceneId: null
    })
  )
  const second = await opened

  // The real Codex, in the second window: entries the backend gave it, not an
  // empty shell.
  await expect(second.locator('.codex-hub, .codex-list, .entity-list').first()).toBeVisible({
    timeout: 30_000
  })
  // And it is a torn-off pane rather than another copy of the whole app.
  await expect(second.locator('.app-shell.detached')).toBeVisible({ timeout: 15_000 })
  await expect(second.locator('.mode-rail')).toHaveCount(0)
  // It opened on the project the pane came from, not on whichever was most
  // recent, and its header is what lets a window with no activity bar be
  // pointed somewhere else.
  expect(
    await second.evaluate(() => window.novalistStores.project.getState().projectPath)
  ).toBe(projectCopy)
  await expect(second.locator('.pane-header')).toBeVisible()

  // The window it came from is untouched.
  await expect(page.locator('.mode-rail')).toBeVisible()

  await closeTestApp(app)
})

test('a detached writing pane retains its scope and an explicit empty selected run', async () => {
  const h = await launchApp('nl-detached-writing-scope-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening', 'Later'] })
    await dismissTour(h.page)
    const chapter = book.chapters.find(item => item.title === 'Chapter')!
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
    await expect(h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Manuscript', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const opened = h.app.waitForEvent('window')
    await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
      const project = window.novalistStores.project.getState()
      await window.novalist.openPaneWindow({ view: 'write', projectPath: project.projectPath,
        bookId: project.activeBookId, draftId: project.activeDraftId,
        chapterGuid, sceneId, writingScope: 'chapter', selectedSceneIds: [] })
    }, { chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id })
    const detached = await opened
    await expect(detached.locator('.app-shell.detached')).toBeVisible()
    await expect(detached.locator('.writing-scope-segments').getByRole('button', { name: 'Chapter', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(detached.frameLocator('iframe[title="editor"]').locator('[data-writing-scene]')).toHaveCount(0)
    await expect(detached.getByRole('button', { name: 'Show whole manuscript', exact: true })).toBeVisible()
    await expect(h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Manuscript', exact: true })).toHaveAttribute('aria-pressed', 'true')
  } finally { await h.close() }
})

test('one undock button sits in the writing bar, a view heading or the pane header, and opens the pane in its own window', async () => {
  test.setTimeout(120_000)
  const h = await launchApp('nl-undock-button-')
  try {
    const book = await seedBook(h, { Chapter: ['Opening'] })
    await dismissTour(h.page)
    const chapter = book.chapters[0]
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
    const undock = h.page.getByRole('button', { name: 'Open in its own window', exact: true })

    // An unsplit Write view: no pane header, so the writing bar carries it.
    await expect(h.page.locator('.pane-header')).toHaveCount(0)
    await expect(undock).toHaveCount(1)
    await expect(h.page.locator('.writing-scope-toolbar .undock-button')).toBeVisible()
    let opened = h.app.waitForEvent('window')
    await undock.click()
    const writer = await opened
    await expect(writer.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
    expect(await writer.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('write')
    // The detached window always shows its pane header, which carries the one button.
    await expect(writer.locator('.pane-header .undock-button')).toHaveCount(1)
    await expect(writer.getByRole('button', { name: 'Open in its own window', exact: true })).toHaveCount(1)
    // A copy, not a move: the main window still shows the editor.
    expect(await h.page.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('write')

    // An unsplit view with a heading: the heading carries it, beside but not
    // inside the view's own actions.
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('codex'))
    await expect(h.page.locator('.desktop-view-heading .undock-button')).toBeVisible()
    await expect(h.page.locator('.desktop-view-actions .undock-button')).toHaveCount(0)
    await expect(undock).toHaveCount(1)
    opened = h.app.waitForEvent('window')
    await undock.click()
    const codex = await opened
    await expect(codex.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
    expect(await codex.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('codex')

    // Split: each pane header carries it and the headings do not.
    await h.page.evaluate(() => window.novalistStores.shell.getState().splitActivePane('row'))
    await expect(h.page.locator('.pane-header .undock-button')).toHaveCount(2)
    await expect(h.page.locator('.desktop-view-heading .undock-button')).toHaveCount(0)
    await expect(undock).toHaveCount(2)

    // The Dashboard has no heading: the View menu and the palette remain.
    await h.page.evaluate(() => window.novalistStores.shell.getState().resetPanes())
    await expect(h.page.locator('.pane-header')).toHaveCount(0)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('dashboard'))
    await expect(undock).toHaveCount(0)
  } finally { await h.close() }
})

test('an extension view survives being undocked, and a saved layout brings it back', async () => {
  test.setTimeout(180_000)
  const settings = mkdtempSync(join(tmpdir(), 'nl-undock-extension-'))
  const extension = join(settings, 'Extensions', 'test.throwing')
  mkdirSync(join(extension, 'web'), { recursive: true })
  mkdirSync(join(extension, 'Locales'), { recursive: true })
  copyFileSync(resolve('../tests/Novalist.TestExtension/bin/Debug/net10.0/Novalist.TestExtension.dll'), join(extension, 'Novalist.TestExtension.dll'))
  writeFileSync(join(extension, 'extension.json'), JSON.stringify({
    id: 'test.throwing', name: 'Undock panel', version: '1.0.0', entryAssembly: 'Novalist.TestExtension.dll',
    contributes: { views: [{ key: 'test.panel', title: 'panel.title', iconPath: 'M4 4h16v16H4z', placement: 'main', mode: 'write', entry: 'web/panel.html' }] }
  }))
  writeFileSync(join(extension, 'Locales', 'en.json'), JSON.stringify({ panel: { title: 'Test panel' } }))
  writeFileSync(join(extension, 'web', 'panel.html'), '<!doctype html><meta charset="utf-8"><body><p id="mark">Extension panel</p></body>')
  const h = await launchApp('nl-undock-extension-ui-', {
    NOVALIST_SETTINGS_DIR: settings,
    NOVALIST_BACKEND_PATH: resolve('../Novalist.Backend/bin/Debug/net10.0/Novalist.Backend' + (process.platform === 'win32' ? '.exe' : ''))
  })
  try {
    await seedBook(h, { One: ['A'] }, 'Spec')
    await dismissTour(h.page)
    await h.page.evaluate(() => window.novalistStores.extensions.getState().load())
    await enterWriting(h.page)
    // The route a writer takes: Write mode, then the extension's row in the
    // mode panel, which shows it without changing the view underneath.
    await h.page.locator('.mode-panel').getByText('Test panel', { exact: true }).click()
    const panel = 'iframe[src^="novalist-ext://test.throwing/"]'
    await expect(h.page.locator(panel)).toHaveCount(1)
    expect(await h.page.evaluate(() => window.novalistStores.shell.getState().mainView)).toBe('write')
    // An unsplit extension view has no heading: the button is not offered there.
    await expect(h.page.locator('.undock-button')).toHaveCount(0)
    await h.page.evaluate(() => window.novalistStores.shell.getState().splitActivePane('row'))
    await expect(h.page.locator(panel)).toHaveCount(2)
    let opened = h.app.waitForEvent('window')
    await h.page.locator('.pane-header .undock-button').first().click()
    const detached = await opened
    await expect(detached.locator('.app-shell.detached')).toBeVisible({ timeout: 30_000 })
    await expect(detached.frameLocator(panel).locator('#mark')).toHaveText('Extension panel', { timeout: 30_000 })
    expect(await detached.evaluate(() => window.novalistStores.shell.getState().extView))
      .toEqual({ extensionId: 'test.throwing', key: 'test.panel' })

    // Saved with a layout, then reopened by applying it.
    await h.page.evaluate(() => window.novalistStores.shell.getState().setLayoutsOpen(true))
    const dialog = h.page.getByRole('dialog', { name: 'Workspace layouts' })
    await dialog.getByPlaceholder('Name this layout').fill('Panel')
    await dialog.getByRole('button', { name: 'Save current', exact: true }).click()
    await expect.poll(() => h.page.evaluate(() => localStorage.getItem('nl.shell.layouts') ?? '')).toContain('test.panel')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const closed = detached.waitForEvent('close')
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((win) => new URL(win.webContents.getURL()).searchParams.has('pane'))!.close()
    })
    await closed
    opened = h.app.waitForEvent('window')
    await h.page.evaluate(() => window.novalistStores.shell.getState().setLayoutsOpen(true))
    await dialog.getByRole('button', { name: 'Panel', exact: true }).click()
    const restored = await opened
    await expect(restored.frameLocator(panel).locator('#mark')).toHaveText('Extension panel', { timeout: 30_000 })
  } finally { await h.close() }
})

test('splitting the editor gives each pane its own scene', async () => {
  test.skip(!existsSync(join(REAL_PROJECT, '.novalist')), 'real project not available')
  test.setTimeout(120_000)

  const workDir = mkdtempSync(join(tmpdir(), 'nl-panes-'))
  const projectCopy = join(workDir, 'project')
  copyProject(REAL_PROJECT, projectCopy)
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')
  ) as Record<string, string>
  env.NOVALIST_SETTINGS_DIR = join(workDir, 'settings')
  env.NOVALIST_NO_SPLASH = '1'

  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${join(env.NOVALIST_SETTINGS_DIR, 'profile')}`], env })
  const page = await app.firstWindow()
  await waitForAppReady(page)
  await evaluateWhenReady(page, async (root) => {
    const state = await window.novalistRpc.request('project/open', [root])
    window.novalistStores.project.getState().applyState(state as never)
  }, projectCopy)

  // Two scenes to tell apart.
  const scenes = await page.evaluate(() => {
    const chapters = window.novalistStores.project.getState().chapters
    const flat = chapters.flatMap((c) =>
      c.scenes.map((s) => ({ chapterGuid: c.guid, sceneId: s.id }))
    )
    return flat.slice(0, 2)
  })
  test.skip(scenes.length < 2, 'project has fewer than two scenes')

  await page.evaluate(
    (scene) => window.novalistStores.project.getState().openScene(scene.chapterGuid, scene.sceneId),
    scenes[0]
  )
  await expect(page.locator('.editor-pane')).toHaveCount(1)

  // Split, then put the second scene in the pane that appeared. It used to be
  // the same scene twice with no way to change either half.
  await page.evaluate(() => window.novalistStores.shell.getState().splitActivePane('row'))
  await expect(page.locator('.pane-header')).toHaveCount(2)
  await expect(page.locator('.pane-divider')).toHaveCount(1)

  await page.evaluate(
    (scene) => window.novalistStores.project.getState().openScene(scene.chapterGuid, scene.sceneId),
    scenes[1]
  )
  await expect(page.locator('.editor-pane')).toHaveCount(2)

  // Two panes, two different scenes.
  const open = await page.evaluate(() =>
    Object.values(window.novalistStores.project.getState().editors).map((e) => e.sceneId)
  )
  expect(open.filter(Boolean)).toHaveLength(2)
  expect(new Set(open.filter(Boolean)).size).toBe(2)

  // A pane can be pointed at something that is not the editor.
  const paneIds = await page.evaluate(() => {
    const leaves: string[] = []
    const walk = (node: { kind: string; id: string; children?: unknown[] }): void => {
      if (node.kind === 'leaf') leaves.push(node.id)
      else (node.children as typeof node[]).forEach(walk)
    }
    walk(window.novalistStores.shell.getState().panes as never)
    return leaves
  })
  await page.evaluate(
    (id) => window.novalistStores.shell.getState().setPaneView(id, 'codex'),
    paneIds[1]
  )
  await expect(page.locator('.editor-pane')).toHaveCount(1)
  // The pane that stopped being an editor keeps its scene. It used to let go
  // of it, which made looking at the Codex in that pane a way of closing the
  // book: point it back at the editor and the writer was returned to "choose a
  // scene in the binder" rather than to what they were writing.
  expect(
    await page.evaluate(
      () =>
        Object.values(window.novalistStores.project.getState().editors).filter((e) => e.sceneId)
          .length
    )
  ).toBe(2)

  // And pointing it back at the editor puts them where they were.
  await page.evaluate(
    (id) => window.novalistStores.shell.getState().setPaneView(id, 'write'),
    paneIds[1]
  )
  await expect(page.locator('.editor-pane')).toHaveCount(2)
  const reopened = await page.evaluate(() =>
    Object.values(window.novalistStores.project.getState().editors).map((e) => e.sceneId)
  )
  expect(new Set(reopened.filter(Boolean)).size).toBe(2)

  await closeTestApp(app)
})
