import { expect, test } from '@playwright/test'
import { dismissTour, launchApp } from './harness'

declare global {
  interface Window { compactionTest: { calls: string[]; pending: boolean } }
}

// After another writer compacts the shared history, a session that fell behind reloads from the newest checkpoint
// on its own, but only when nothing it wrote is still waiting to be sent.
test('a session behind a compaction refreshes itself only when nothing is waiting to be sent', async () => {
  const h = await launchApp('nl-collaboration-compaction-')
  try {
    await dismissTour(h.page)
    await h.page.evaluate(() => {
      window.compactionTest = { calls: [], pending: true }
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      let resumed = false
      const session = (connection: string): Record<string, unknown> => ({ sessionId: resumed ? 'fresh' : 'behind', projectId: 'project',
        server: 'https://example.invalid/', connection, isOwner: false, recoveryPath: null, mode: 'persistent',
        hasPendingUpdates: window.compactionTest.pending })
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'collaboration/status') return session(resumed ? 'Connected' : 'CheckpointRefreshRequired') as T
        if (method === 'collaboration/saved') return null as T
        if (method === 'collaboration/end' || method === 'collaboration/persistent/resume') {
          window.compactionTest.calls.push(method)
          if (method === 'collaboration/end') return null as T
          resumed = true
          return session('Connected') as T
        }
        return original<T>(method, params)
      }
    })

    await h.page.evaluate(() => window.novalistStores.hostedSession.getState().refresh())
    expect(await h.page.evaluate(() => window.compactionTest.calls)).toEqual([])

    await h.page.evaluate(() => { window.compactionTest.pending = false })
    await h.page.evaluate(() => window.novalistStores.hostedSession.getState().refresh())

    await expect.poll(() => h.page.evaluate(() => window.compactionTest.calls))
      .toEqual(['collaboration/end', 'collaboration/persistent/resume'])
    await expect.poll(() => h.page.evaluate(() => window.novalistStores.hostedSession.getState().session?.sessionId)).toBe('fresh')
  } finally { await h.close() }
})
