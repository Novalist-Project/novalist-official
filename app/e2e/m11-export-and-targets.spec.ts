import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateWhenReady, waitForAppReady } from './appReady'
import { dismissTour } from './harness'

/**
 * Three controls that were wrong in ways only running the app showed.
 *
 * The export form asked what to export and what file to write as one question.
 * Word targets existed but could only be reached by right-clicking in the
 * binder. Both are the kind of defect that a unit test cannot see: every piece
 * worked, and none of them was anywhere a writer would look.
 */
test('export separates what from how, and targets are reachable from Settings', async () => {
  test.setTimeout(120_000)

  const workDir = mkdtempSync(join(tmpdir(), 'nl-export-'))
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')
  ) as Record<string, string>
  env.NOVALIST_NO_SPLASH = '1'
  env.NOVALIST_SETTINGS_DIR = join(workDir, 'settings')

  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${join(workDir, 'profile')}`], env })
  const page = await app.firstWindow()
  await waitForAppReady(page)

  await evaluateWhenReady(page, async (parent) => {
    const state = await window.novalistRpc.request('project/create', [parent, 'Targets', 'Book One'])
    window.novalistStores.project.getState().applyState(state as never)
    const withChapter = await window.novalistRpc.request('project/createChapter', ['Chapter One'])
    window.novalistStores.project.getState().applyState(withChapter as never)
  }, workDir)
  await dismissTour(page)

  // ── Export: content and format are separate questions ──
  await page.evaluate(() => window.novalistStores.shell.getState().setMainView('export'))
  await expect(page.locator('#export-content')).toBeVisible({ timeout: 20_000 })

  // The manuscript formats no longer have the world bible mixed in among them.
  const manuscriptFormats = await page.locator('#export-format option').allTextContents()
  expect(manuscriptFormats).toEqual([
    'EPUB (e-book)',
    'DOCX (Word)',
    'PDF',
    'Markdown',
    'Final Draft (.fdx)',
    'LaTeX',
    // An edition of the book like any other, compiled from the same selection -
    // it simply takes hours and comes out as sound.
    'Audiobook'
  ])

  await page.selectOption('#export-content', 'codex')
  expect(await page.locator('#export-format option').allTextContents()).toEqual(['Markdown', 'PDF'])

  // Switching back keeps the format that was picked for the manuscript.
  await page.selectOption('#export-content', 'manuscript')
  expect(await page.locator('#export-format').inputValue()).toBe('Epub')

  // ── One list of layouts, which the layout panel edits ──
  await expect(page.locator('#export-preset option').first()).toBeAttached({ timeout: 20_000 })
  const presets = await page.locator('#export-preset option').allTextContents()
  expect(presets.length).toBeGreaterThanOrEqual(4)
  expect(presets[0]).toContain('Default')

  const layoutPanel = page.locator('.export-matter', { hasText: 'Export layouts' })
  await layoutPanel.locator('summary').click()
  // No second layout picker: the panel edits whatever the export form has
  // picked. Its own property dropdowns - numbering style, trim size - are not
  // what this is about, so the assertion names the picker rather than counting
  // every select in the panel.
  await expect(layoutPanel.locator('#export-preset')).toHaveCount(0)
  await page.selectOption('#export-preset', 'shunn-manuscript')
  await expect(layoutPanel.locator('.settings-hint').first()).toHaveText('Shunn Manuscript Format')

  // Duplicating switches the export to the copy, which is the one being edited.
  await layoutPanel.getByRole('button', { name: 'Duplicate' }).click()
  await expect(page.locator('#export-preset option')).toHaveCount(presets.length + 1, {
    timeout: 10_000
  })
  expect(await page.locator('#export-preset').inputValue()).toContain('custom-')

  // ── Word targets, from Settings rather than only the binder's context menu ──
  await page.evaluate(() => window.novalistStores.shell.getState().openSettings('writingGoals'))
  await expect(page.locator('#set-daily-goal')).toBeVisible({ timeout: 20_000 })

  await page.locator('#set-daily-goal').fill('1500')
  await page.locator('#set-daily-goal').blur()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() =>
          window.novalistRpc.request('dashboard/get', [30])
        )) as { dailyGoalTarget: number },
      { timeout: 10_000 }
    )
    .toMatchObject({ dailyGoalTarget: 1500 })

  // The chapter can be given a target here, and it shows up as a row.
  await page.locator('.dashboard-target-add select').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Set target' }).click()
  // Scoped to the dialog: the settings page is full of .dialog-input fields.
  await page.locator('.dialog-card .dialog-input').fill('4000')
  await page.locator('.dialog-card .dialog-button.primary').click()

  await expect(page.locator('.dashboard-target-row')).toHaveCount(1, { timeout: 10_000 })
  const formattedTarget = await page.evaluate(() => (4000).toLocaleString())
  await expect(page.locator('.dashboard-target-row')).toContainText(formattedTarget)

  await app.close()
})

/**
 * The EPUB names its cover for a reader who cannot see it. The description is
 * asked for under the cover toggle, only when there is a cover to describe, and
 * is saved with the book so the next export uses it.
 */
test('the cover description sits under the cover and is saved with the book', async () => {
  test.setTimeout(120_000)

  const workDir = mkdtempSync(join(tmpdir(), 'nl-cover-alt-'))
  const cover = join(workDir, 'cover.png')
  writeFileSync(cover, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ))
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')
  ) as Record<string, string>
  env.NOVALIST_NO_SPLASH = '1'
  env.NOVALIST_SETTINGS_DIR = join(workDir, 'settings')

  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${join(workDir, 'profile')}`], env })
  const page = await app.firstWindow()
  await waitForAppReady(page)

  await evaluateWhenReady(page, async (parent) => {
    const state = await window.novalistRpc.request('project/create', [parent, 'Covered', 'Book One'])
    window.novalistStores.project.getState().applyState(state as never)
    const withChapter = await window.novalistRpc.request('project/createChapter', ['Chapter One'])
    window.novalistStores.project.getState().applyState(withChapter as never)
  }, workDir)
  await dismissTour(page)

  // No cover yet: there is nothing to describe, so the field is not offered.
  await page.evaluate(() => window.novalistStores.shell.getState().setMainView('export'))
  await expect(page.locator('#export-format')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#export-cover-alt')).toHaveCount(0)

  // With a cover the field appears under the cover toggle once Export reopens.
  await page.evaluate((path) => window.novalistRpc.request('dashboard/setCover', [path]), cover)
  await page.evaluate(() => window.novalistStores.shell.getState().setMainView('dashboard'))
  await page.evaluate(() => window.novalistStores.shell.getState().setMainView('export'))
  const field = page.locator('#export-cover-alt')
  await expect(field).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Cover description')).toBeVisible()

  await field.fill('A lighthouse in a storm')
  await field.blur()
  await expect
    .poll(() => page.evaluate(() => window.novalistRpc.request('dashboard/getCoverAltText')), {
      timeout: 10_000
    })
    .toBe('A lighthouse in a storm')

  // Leaving the cover out of the file leaves nothing to describe.
  await page.getByLabel('Include the book cover').uncheck()
  await expect(field).toHaveCount(0)

  await app.close()
})
