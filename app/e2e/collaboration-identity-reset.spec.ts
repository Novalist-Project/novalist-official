import { expect, test } from '@playwright/test'
import { dismissTour, launchApp } from './harness'

test('lost-device reset requires explicit forfeiture confirmation before the MFA RPC', async () => {
  const h = await launchApp('nl-collaboration-identity-reset-')
  try {
    await dismissTour(h.page)
    await h.page.evaluate(() => {
      const account = { subject: 'writer', displayName: 'Test Writer', deviceRegistered: false,
        deviceRegistrationError: 'Link this device from an authorized device or recovery key.' }
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      const calls: { method: string; params?: unknown }[] = []
      Object.assign(window, { identityResetCalls: calls })
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'collaboration/account/configuration') return { authenticationRequired: true, accountIdentityReset: true } as T
        if (method === 'collaboration/account/status') return account as T
        if (method === 'collaboration/account/resetIdentity') {
          calls.push({ method, params })
          return { ...account, deviceRegistrationError: null } as T
        }
        if (method === 'collaboration/account/enrollDevice') {
          calls.push({ method, params })
          return null as T
        }
        return original<T>(method, params)
      }
    })
    await h.page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-collaboration-trigger][aria-expanded="false"]')?.click())
    await h.page.locator('#set-collaboration-mode').selectOption('persistent')
    await h.page.getByLabel('Server address', { exact: true }).fill('https://sync.example/')
    await expect(h.page.getByRole('alert').filter({ hasText: 'Link this device' })).toBeVisible()
    await h.page.getByRole('button', { name: 'Reset lost-device identity', exact: true }).click()
    const confirm = h.page.getByRole('button', { name: 'Reset identity with fresh MFA', exact: true })
    await expect(confirm).toBeDisabled()
    await expect(h.page.getByRole('alert').filter({ hasText: 'including projects you owned' })).toBeVisible()
    await h.page.getByRole('checkbox', { name: 'I understand that I am giving up all previous project access and ownership.' }).check()
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(h.page.getByRole('status').filter({ hasText: 'Identity reset.' })).toBeVisible()
    expect(await h.page.evaluate(() => (window as unknown as { identityResetCalls: unknown[] }).identityResetCalls))
      .toEqual([{ method: 'collaboration/account/resetIdentity', params: ['https://sync.example/', true] }])
    await h.page.getByRole('button', { name: 'Register this device', exact: true }).click()
    await expect(h.page.getByRole('button', { name: 'Reset lost-device identity', exact: true })).toHaveCount(0)
  } finally { await h.close() }
})
