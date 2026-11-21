import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateWhenReady, waitForAppReady } from './appReady'
import { enterWriting } from './harness'

/**
 * M1 exit criterion, against the real app (built renderer + real backend):
 * create project -> chapter -> scene -> type in the real editor.html ->
 * autosave persists to disk -> content survives in the scene file.
 */

function findSceneFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.novalist')) found.push(full)
    }
  }
  walk(root)
  return found
}

test('project + binder + editor round-trip', async () => {
  test.setTimeout(180_000)
  const workDir = mkdtempSync(join(tmpdir(), 'nl-e2e-'))

  // VS Code (and other Electron hosts) exports ELECTRON_RUN_AS_NODE, which would
  // make the launched binary behave as plain Node and reject Playwright's flags.
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')
  ) as Record<string, string>
  env.NOVALIST_SETTINGS_DIR = join(workDir, 'settings')
  env.NOVALIST_NO_SPLASH = '1'

  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${join(env.NOVALIST_SETTINGS_DIR, 'profile')}`], env })
  const page = await app.firstWindow()

  // Wait for the backend handshake before opening a project.
  await waitForAppReady(page)

  // connect() must be idempotent: a repeat call (as React StrictMode triggers in
  // dev) must not open a second port channel and orphan the live one. After a
  // second connect, RPC must still flow.
  const stillConnected = await evaluateWhenReady(page, async () => {
    await window.novalistRpc.connect()
    const ping = (await window.novalistRpc.request('system/ping')) as { version: string }
    return Boolean(ping.version)
  })
  expect(stillConnected).toBe(true)

  // Create + open a project through the app's own RPC client (bypasses the native picker).
  await page.evaluate(async (dir) => {
    const state = await window.novalistRpc.request('project/create', [dir, 'E2E Novel', 'Book One'])
    window.novalistStores.project.getState().applyState(state as never)
  }, workDir)

  // A created project opens on the Dashboard, which is about the book and so
  // has no binder; the round-trip below is the Write workspace's.
  await enterWriting(page)

  await page.evaluate(() => window.novalistStores.project.getState().createChapter('Chapter One'))
  await expect(page.locator('.binder-chapter-title')).toHaveText('Chapter One')

  const sceneId = await page.evaluate(async () => {
    const store = window.novalistStores.project.getState()
    await store.createScene(store.chapters[0].guid, 'Opening')
    return window.novalistStores.project.getState().chapters[0].scenes.find(scene => scene.title === 'Opening')!.id
  })
  const sceneRow = page.locator('.binder-scene-row').filter({ hasText: 'Opening' })
  await expect(sceneRow).toHaveCount(1)

  // Open the scene: the real editor.html loads in the iframe.
  await sceneRow.click()
  const editor = page.frameLocator('.editor-frame').locator(`[data-writing-scene="${sceneId}"]`)
  await expect(editor).toBeVisible({ timeout: 30_000 })

  // Browser-painted chrome (scrollbars, form widgets) must follow the theme
  // instead of falling back to the light OS default - in the shell and in the
  // editor document, which is a separate frame the host has to push colours to.
  const chrome = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return {
      colorScheme: style.colorScheme,
      thumb: style.getPropertyValue('--nl-scrollbar-thumb').trim(),
      accent: style.accentColor
    }
  })
  expect(chrome.colorScheme).toBe('dark')
  expect(chrome.thumb).not.toBe('')
  expect(chrome.accent).not.toBe('auto')

  const editorChrome = await page
    .frameLocator('.editor-frame')
    .locator(':root')
    .evaluate((root) => ({
      colorScheme: getComputedStyle(root).colorScheme,
      thumb: (root as HTMLElement).style.getPropertyValue('--scrollbar-thumb').trim()
    }))
  expect(editorChrome.colorScheme).toBe('dark')
  expect(editorChrome.thumb).not.toBe('')

  // Type prose and let the 2s autosave fire.
  await editor.click()
  await page.keyboard.type('It was a dark and stormy night.')

  // The scene file on disk now contains the typed text. The autosave runs on a
  // timer and a slow machine can take longer than any fixed wait to finish it.
  const projectRoot = join(workDir, 'E2E Novel')
  await expect.poll(() => {
    const sceneFiles = findSceneFiles(projectRoot)
    return sceneFiles.some((f) => readFileSync(f, 'utf8').includes('dark and stormy night'))
  }, { message: 'the typed prose should reach a scene file', timeout: 30_000 }).toBe(true)

  // Reopen the project fresh: state round-trips with a persisted word count.
  const reopened = (await page.evaluate((root) => {
    return window.novalistRpc.request('project/open', [root])
  }, projectRoot)) as { chapters: { scenes: { id: string; wordCount: number }[] }[] }
  expect(reopened.chapters[0].scenes.find(scene => scene.id === sceneId)?.wordCount).toBe(7)

  await app.close()
})
