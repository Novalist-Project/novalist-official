import { test, expect } from '@playwright/test'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'
import type { ProjectStateDto } from '../src/renderer/src/stores/projectTypes'

async function openFilteredBook(h: Harness, legacyPreset = false): Promise<void> {
  const book = await seedBook(h, {
    'Revised chapter': ['First draft A', 'First draft B'],
    'First draft chapter': ['Outline A', 'Outline B']
  }, 'Spec', false)
  const [drafted, outlined] = book.chapters
  await h.rpc('project/setChapterStatus', [drafted.guid, 'Revised'])
  await h.rpc('project/setChapterStatus', [outlined.guid, 'FirstDraft'])
  for (const scene of drafted.scenes) await h.rpc('stages/setSceneStage', [drafted.guid, scene.id, 'firstDraft'])
  for (const scene of outlined.scenes) await h.rpc('stages/setSceneStage', [outlined.guid, scene.id, 'outline'])
  await h.page.evaluate(state => window.novalistStores.project.getState().applyState(state),
    await h.rpc<ProjectStateDto>('project/getState'))
  await dismissTour(h.page)
  await h.page.evaluate((legacy) => {
    if (legacy) localStorage.setItem(`nl.filters.${window.novalistStores.project.getState().projectPath}`, JSON.stringify([
      { name: 'Old chapter query', filter: { status: 'Revised', stage: '', character: '', location: '', plotline: '' } }
    ]))
    window.novalistStores.shell.getState().setMainView('structure')
  }, legacyPreset)
  await h.page.locator('.manuscript-modes').getByRole('button', { name: 'Outliner', exact: true }).click()
  await expect(h.page.locator('.outliner-scene-title')).toHaveText(['First draft A', 'First draft B', 'Outline A', 'Outline B'])
  await h.page.locator('.filter-bar-toggle').click()
}

test('scene-stage filters match scenes independently of legacy chapter status and survive presets', async () => {
  const h = await launchApp('nl-shared-stages-')
  try {
    await openFilteredBook(h)
    const stage = h.page.getByRole('combobox', { name: 'Scene stage', exact: true })
    const titles = h.page.locator('.outliner-scene-title')
    await stage.selectOption('firstDraft')
    await expect(titles).toHaveText(['First draft A', 'First draft B'])
    await stage.selectOption('outline')
    await expect(titles).toHaveText(['Outline A', 'Outline B'])
    await h.page.locator('.filter-presets input').fill('Outline pass')
    await h.page.locator('.filter-presets input').press('Enter')
    await stage.selectOption('firstDraft')
    await expect(titles).toHaveText(['First draft A', 'First draft B'])
    await h.page.getByRole('button', { name: 'Outline pass', exact: true }).click()
    await expect(titles).toHaveText(['Outline A', 'Outline B'])
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('timeline'))
    await expect(stage).toHaveValue('outline')
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('structure'))
    await expect(titles).toHaveText(['Outline A', 'Outline B'])
    await h.page.getByRole('button', { name: 'Clear 1', exact: true }).click()
    await expect(titles).toHaveCount(4)
  } finally { await h.close() }
})

test('manuscript and binder have no chapter-status controls', async () => {
  const h = await launchApp('nl-stage-controls-')
  try {
    await openFilteredBook(h)
    await expect(h.page.getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0)
    await expect(h.page.locator('.binder-status-dot')).toHaveCount(0)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('manuscript'))
    const frame = h.page.frameLocator('iframe[title="editor"]')
    await expect(frame.locator('[data-writing-scene]')).toHaveCount(4)
    await expect(frame.locator('.chapter-status')).toHaveCount(0)
  } finally { await h.close() }
})

test('old chapter-status presets remain explicit and can be cleared independently', async () => {
  const h = await launchApp('nl-legacy-filter-')
  try {
    await openFilteredBook(h, true)
    await h.page.getByRole('button', { name: 'Old chapter query', exact: true }).click()
    await expect(h.page.getByText('Legacy chapter status: Revised', { exact: true })).toBeVisible()
    await expect(h.page.locator('.outliner-scene-title')).toHaveText(['First draft A', 'First draft B'])
    await h.page.getByRole('combobox', { name: 'Scene stage', exact: true }).selectOption('outline')
    await expect(h.page.locator('.outliner-scene-title')).toHaveCount(0)
    await h.page.getByRole('button', { name: 'Clear chapter status filter', exact: true }).click()
    await expect(h.page.locator('.outliner-scene-title')).toHaveText(['Outline A', 'Outline B'])
    await expect(h.page.getByRole('combobox', { name: 'Scene stage', exact: true })).toHaveValue('outline')
  } finally { await h.close() }
})

test('manuscript loads the scene-stage filter selected in another view', async () => {
  const h = await launchApp('nl-stage-state-')
  try {
    await openFilteredBook(h)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('timeline'))
    await h.page.locator('.filter-bar-toggle').click()
    await h.page.getByRole('combobox', { name: 'Scene stage', exact: true }).selectOption('firstDraft')
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('manuscript'))
    await expect(h.page.frameLocator('iframe[title="editor"]').locator('[data-writing-scene]')).toHaveCount(2)
    await expect(h.page.locator('iframe[src*="manuscript-editor"]')).toHaveCount(0)
  } finally { await h.close() }
})
