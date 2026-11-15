import { expect, test } from '@playwright/test'
import { dismissTour, launchApp } from './harness'

declare global {
  interface Window { mergeTest: { resolved: unknown[] } }
}

// Reconnecting to a persistent server after writing offline asks about the places another writer changed too,
// and sends one choice per place. Deciding later keeps the conflicts until the writer comes back to them.
test('conflicting offline writing waits for a choice per place after reconnecting', async () => {
  const h = await launchApp('nl-collaboration-merge-')
  try {
    await dismissTour(h.page)
    await h.page.evaluate(() => {
      window.mergeTest = { resolved: [] }
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      let conflicts = 2
      const session = (): Record<string, unknown> => ({ sessionId: 'session', projectId: 'project', server: 'https://example.invalid/',
        connection: 'Connected', isOwner: true, recoveryPath: null, mode: 'persistent', conflicts })
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'collaboration/persistent/resume') return session() as T
        if (method === 'collaboration/persistent/conflicts') return [
          { path: 'Book/Chapters/01/arrival.md', id: 'item:0-1', kind: 'prose', label: 'Opening · Arrival',
            local: '<p>The door was open.</p>', server: '<p>The door was shut.</p>' },
          { path: 'Book/Characters/mira.json', id: 'field:age', kind: 'field', label: 'Mira · age', local: '50', server: '40' }
        ] as T
        if (method === 'collaboration/persistent/resolveConflicts') {
          window.mergeTest.resolved.push(params)
          conflicts = 0
          return session() as T
        }
        return original<T>(method, params)
      }
    })

    await h.page.evaluate(() => window.novalistStores.hostedSession.getState().run('persistentResume', []))
    const dialog = h.page.getByRole('dialog', { name: 'Changes made while disconnected' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Opening · Arrival')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'The door was open.' })).toHaveAttribute('aria-pressed', 'true')

    await dialog.getByRole('button', { name: 'Decide later' }).click()
    await expect(dialog).toBeHidden()
    await h.page.evaluate(() => window.novalistStores.hostedSession.getState().showConflicts(true))
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'Keep all shared' }).click()
    await dialog.getByRole('button', { name: 'The door was open.' }).click()
    await dialog.getByRole('button', { name: 'Apply choices' }).click()
    await expect(dialog).toBeHidden()
    expect(await h.page.evaluate(() => window.mergeTest.resolved)).toEqual([[[
      { path: 'Book/Chapters/01/arrival.md', id: 'item:0-1', keep: 'local' },
      { path: 'Book/Characters/mira.json', id: 'field:age', keep: 'server' }
    ]]])
    expect(await h.page.evaluate(() => window.novalistStores.hostedSession.getState().session?.conflicts)).toBe(0)
  } finally { await h.close() }
})
