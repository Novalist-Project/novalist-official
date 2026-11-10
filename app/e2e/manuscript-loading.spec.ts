import { expect, test } from '@playwright/test'
import { dismissTour, launchApp, seedBook } from './harness'

declare global { interface Window { manuscriptLoad: { calls: number; legacyCalls: number; release(): void; restore(): void } } }

test('Manuscript scope shows loading instead of a false empty run and passively reads each scene once', async () => {
  const app = await launchApp('nl-manuscript-loading-')
  try {
    await seedBook(app, { Opening: ['Arrival'] }, 'Spec', false)
    await dismissTour(app.page)
    await app.page.evaluate(() => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      window.manuscriptLoad = { calls: 0, legacyCalls: 0, release() {}, restore() {} }
      const pending = new Promise<void>(resolve => { window.manuscriptLoad.release = resolve })
      window.manuscriptLoad.restore = () => { window.manuscriptLoad.release(); window.novalistRpc.request = original }
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'manuscript/get') window.manuscriptLoad.legacyCalls++
        if (method === 'scenes/readPassive') { window.manuscriptLoad.calls++; await pending }
        return original<T>(method, params)
      }
      window.novalistStores.shell.getState().setMainView('manuscript')
    })
    await expect(app.page.locator('.unified-writing-editor').getByRole('status')).toHaveText('Loading...')
    await expect(app.page.locator('.writing-empty')).toHaveCount(0)
    await expect(app.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toHaveCount(0)
    expect(await app.page.evaluate(() => window.manuscriptLoad.calls)).toBe(1)
    await app.page.evaluate(() => window.manuscriptLoad.release())
    await expect(app.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toHaveCount(1)
    await expect(app.page.locator('.unified-writing-editor').getByRole('status')).toHaveCount(0)
    expect(await app.page.evaluate(() => window.manuscriptLoad.calls)).toBe(1)
    expect(await app.page.evaluate(() => window.manuscriptLoad.legacyCalls)).toBe(0)
  } finally {
    await app.page.evaluate(() => window.manuscriptLoad?.restore())
    await app.close()
  }
})
