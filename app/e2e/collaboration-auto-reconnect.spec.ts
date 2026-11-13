import { expect, test } from '@playwright/test'
import { dismissTour, launchApp, seedBook } from './harness'

declare global {
  interface Window { reconnectTest: { calls: string[]; connected: boolean } }
}

// A project with a saved persistent session reconnects once when it opens. Ending the session does not
// trigger another attempt, and turning the project's option off stops the reconnect on the next open.
test('a saved persistent session reconnects when its project opens, unless the project opts out', async () => {
  const h = await launchApp('nl-collaboration-auto-reconnect-')
  try {
    await dismissTour(h.page)
    await h.page.evaluate(() => {
      window.reconnectTest = { calls: [], connected: false }
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      const session = { sessionId: 'session', projectId: 'project', server: 'https://sync.example/', connection: 'Connected',
        isOwner: true, recoveryPath: null, mode: 'persistent', hasPendingUpdates: false }
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'collaboration/status') return (window.reconnectTest.connected ? session : null) as T
        if (method === 'collaboration/saved')
          return (window.novalistStores.project.getState().projectPath
            ? { server: 'https://sync.example/', projectId: 'project', recoveryPath: null, mode: 'persistent' } : null) as T
        if (method === 'collaboration/persistent/resume' || method === 'collaboration/end') {
          window.reconnectTest.calls.push(method)
          window.reconnectTest.connected = method === 'collaboration/persistent/resume'
          return (window.reconnectTest.connected ? session : null) as T
        }
        return original<T>(method, params)
      }
    })
    await seedBook(h, { One: ['Opening'] })
    await expect.poll(() => h.page.evaluate(() => window.reconnectTest.calls)).toEqual(['collaboration/persistent/resume'])

    await h.page.evaluate(() => window.novalistStores.hostedSession.getState().run('end'))
    await h.page.waitForTimeout(2500)
    expect(await h.page.evaluate(() => window.reconnectTest.calls)).toEqual(['collaboration/persistent/resume', 'collaboration/end'])

    await h.page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-collaboration-trigger][aria-expanded="false"]')?.click())
    const option = h.page.getByLabel('Reconnect automatically when this project opens', { exact: true })
    await expect(option).toBeChecked()
    await option.uncheck()
    await expect(h.page.locator('#set-collaboration-mode')).toHaveValue('persistent')

    const path = await h.page.evaluate(() => window.novalistStores.project.getState().projectPath)
    await h.page.evaluate(async (project) => {
      await window.novalistStores.project.getState().closeProject()
      await window.novalistStores.project.getState().openProject(project!)
    }, path)
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().projectPath)).toBe(path)
    await h.page.waitForTimeout(2500)
    expect(await h.page.evaluate(() => window.reconnectTest.calls)).toEqual(['collaboration/persistent/resume', 'collaboration/end'])
  } finally { await h.close() }
})

// The connection type picked for a project comes back when that project opens, even before it was ever shared.
test('each project remembers its own connection type', async () => {
  const h = await launchApp('nl-collaboration-remembered-mode-')
  try {
    await dismissTour(h.page)
    await seedBook(h, { One: ['Opening'] })
    const trigger = '[data-collaboration-trigger][aria-expanded="false"]'
    await h.page.evaluate((selector) => document.querySelector<HTMLButtonElement>(selector)?.click(), trigger)
    await h.page.locator('#set-collaboration-mode').selectOption('hosted')
    const path = await h.page.evaluate(() => window.novalistStores.project.getState().projectPath)
    expect(await h.page.evaluate((project) => JSON.parse(localStorage.getItem('novalist.collaboration.project:' + project) ?? '{}').mode, path))
      .toBe('hosted')
    await h.page.reload()
    await h.page.waitForFunction(() => Boolean(window.novalistStores?.shell.getState().backendVersion))
    await h.page.evaluate(async (project) => { await window.novalistStores.project.getState().openProject(project!) }, path)
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.project.getState().projectPath)).toBe(path)
    await h.page.evaluate((selector) => document.querySelector<HTMLButtonElement>(selector)?.click(), trigger)
    await expect(h.page.locator('#set-collaboration-mode')).toHaveValue('hosted')
  } finally { await h.close() }
})
