import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateWhenReady, waitForAppReady } from './appReady'

/**
 * A starting point for the entity types a worldbuilder ends up needing.
 *
 * The custom type builder is an empty form, so everybody who wants species, a
 * magic system, factions or a language rebuilds the same field list by hand -
 * and rebuilds it differently in every project.
 */
test('a type pack fills the builder, and creates nothing until it is saved', async () => {
  test.setTimeout(120_000)

  const workDir = mkdtempSync(join(tmpdir(), 'nl-packs-'))
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')
  ) as Record<string, string>
  env.NOVALIST_NO_SPLASH = '1'
  env.NOVALIST_SETTINGS_DIR = join(workDir, 'settings')

  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${join(env.NOVALIST_SETTINGS_DIR, 'profile')}`], env })
  const page = await app.firstWindow()
  await waitForAppReady(page)

  await evaluateWhenReady(page, async (parent) => {
    const state = await window.novalistRpc.request('project/create', [parent, 'Packs', 'Book One'])
    window.novalistStores.project.getState().applyState(state as never)
  }, workDir)
  await expect(page.locator('.mode-rail')).toBeVisible({ timeout: 30_000 })

  await page.evaluate(async () => {
    await window.novalistStores.settings.getState().update('global', { language: 'ar' })
    window.novalistStores.shell.getState().setMainView('codex')
  })
  await page.locator('.codex-tab-manage').click()

  const packs = page.locator('.type-pack')
  await expect.poll(() => packs.count(), { timeout: 15_000 }).toBeGreaterThan(3)

  // Listing them creates nothing.
  expect(
    await page.evaluate(() =>
      window.novalistRpc.request<unknown[]>('entities/customTypes').then((t) => t.length)
    )
  ).toBe(0)

  await packs.filter({ hasText: 'نظام سحري' }).click()

  // The form is filled in and still the writer's to change: the field that
  // keeps an ending earned is in there, with the question it is for.
  const card = page.locator('.type-manager-card')
  await expect(card.locator('input.dialog-input').first()).toHaveValue('نظام سحري')
  const firstField = card.locator('.type-manager-field').first()
  await expect(firstField.locator('input').first()).toHaveValue('المصدر')
  await expect(firstField.locator('.type-manager-prompt')).toHaveValue('من أين تأتي القوة، وهل يمكن أن تنفد؟')
  await expect(firstField.locator('option[value="EntityRef"]')).toContainText('ربط بعنصر آخر')
  await firstField.locator('input').first().fill('My source')
  await firstField.locator('select').first().selectOption('Bool')
  await firstField.locator('select').nth(1).selectOption('false')

  // Still nothing created until it is saved.
  expect(
    await page.evaluate(() =>
      window.novalistRpc.request<unknown[]>('entities/customTypes').then((t) => t.length)
    )
  ).toBe(0)

  await card.locator('.dialog-actions .dialog-button.primary').click()
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.novalistRpc
            .request<{ defaultFields: { displayName: string; prompt: string }[] }[]>(
              'entities/customTypes'
            )
            .then((types) => types.flatMap((ty) => ty.defaultFields).filter((f) => f.prompt).length)
        ),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(3)

  await card.locator('.type-manager-title-row button').click()
  const entry = await page.evaluate(async () => {
    const { id } = await window.novalistRpc.request<{ id: string }>('entities/create', ['magic_system', 'Arcana'])
    await window.novalistStores.codex.getState().setType('magic_system')
    await window.novalistStores.codex.getState().select(id)
    return id
  })
  const choice = page.getByRole('combobox', { name: 'My source', exact: true })
  await expect(choice).toHaveValue('false')
  await expect(choice.locator('option[value="true"]')).toContainText('نعم')
  await expect(choice.locator('option[value="false"]')).toContainText('لا')
  await choice.selectOption('true')
  await expect.poll(() => page.evaluate(async id => {
    const saved = await window.novalistRpc.request<{ fields: Record<string, string> }>('entities/get', ['magic_system', id])
    return saved.fields.source
  }, entry)).toBe('true')
  await page.evaluate(() => window.novalistStores.settings.getState().update('global', { language: 'en' }))
  await expect(choice.locator('option[value="true"]')).toHaveText('Yes')
  await expect(choice).toHaveValue('true')

  await app.close()
})
