import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'

async function closeWindow(writer: Harness): Promise<void> {
  await writer.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => writer.app.windows().length, { timeout: 20_000 }).toBe(0)
}

test('both writers can close their windows normally after saving shared prose', async () => {
  const writers: Harness[] = []
  try {
    const host = await launchApp('nl-collab-close-host-')
    writers.push(host)
    const project = await seedBook(host, { Opening: ['Arrival'] })
    const chapter = project.chapters.find(chapter => chapter.title === 'Opening')!
    const scene = chapter.scenes[0]
    await host.rpc('collaboration/peer/host', ['127.0.0.1', 0, 'Morgan'])
    const invitation = await host.rpc<string>('collaboration/invite', [new Date(Date.now() + 60_000).toISOString()])
    const guest = await launchApp('nl-collab-close-guest-')
    writers.push(guest)
    await guest.rpc('collaboration/peer/join', [invitation, join(guest.workDir, 'Joined'), 'Alex'])
    for (const writer of writers) {
      await dismissTour(writer.page)
      await writer.page.evaluate(({ chapter, scene }) => window.novalistStores.project.getState().openScene(chapter, scene), { chapter: chapter.guid, scene: scene.id })
    }
    const editor = guest.page.frameLocator('iframe[title="editor"]').locator('#editor')
    await editor.click()
    await guest.page.keyboard.type('Saved before normal close.')
    await expect(host.page.frameLocator('iframe[title="editor"]').locator('#editor')).toContainText('Saved before normal close.')
    await closeWindow(guest)
    await closeWindow(host)
  } finally {
    for (const writer of writers.reverse()) await writer.close().catch(() => {})
  }
})

test('a disconnected guest can end collaboration and close after focusing a field', async () => {
  const writers: Harness[] = []
  try {
    const host = await launchApp('nl-collab-offline-host-')
    writers.push(host)
    await seedBook(host, { Opening: ['Arrival'] })
    const entity = await host.rpc<{ id: string }>('entities/create', ['character', 'Writer'])
    await host.rpc('collaboration/peer/host', ['127.0.0.1', 0, 'Morgan'])
    const invitation = await host.rpc<string>('collaboration/invite', [new Date(Date.now() + 60_000).toISOString()])
    const guest = await launchApp('nl-collab-offline-guest-')
    writers.push(guest)
    await guest.rpc('collaboration/peer/join', [invitation, join(guest.workDir, 'Joined'), 'Alex'])
    await dismissTour(guest.page)
    await guest.page.evaluate(async id => {
      window.novalistStores.shell.getState().setMainView('codex')
      await window.novalistStores.codex.getState().setType('character')
      await window.novalistStores.codex.getState().select(id)
    }, entity.id)
    await closeWindow(host)
    await expect.poll(async () => (await guest.rpc<{ connection: string }>('collaboration/status')).connection).toBe('Reconnecting')
    const age = guest.page.getByRole('textbox', { name: 'Age', exact: true })
    await age.focus()
    await expect(guest.page.getByRole('alert')).toContainText('Reconnect before changing shared project details or structure.')
    await age.blur()
    await guest.rpc('collaboration/end')
    expect(await guest.rpc('collaboration/status')).toBeNull()
    await closeWindow(guest)
  } finally {
    for (const writer of writers.reverse()) await writer.close().catch(() => {})
  }
})
