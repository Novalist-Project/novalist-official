import { expect, test, type Page } from '@playwright/test'
import { dismissTour, launchApp, seedBook } from './harness'
import { flushWriting, replaceWritingScene } from './writingTestActions'
import type { WritingCommitRequest } from '../src/renderer/src/views/editor/writingTypes'
import * as Y from 'yjs'

interface RecoveryProbe {
  owner: unknown
  blocked: boolean
  recoverySeen: boolean
  commits: WritingCommitRequest[]
  restore(): void
}
interface SharedRecoveryProbe { recoverySeen: boolean; sessionId: string; ordinaryWrites: number }
declare global { interface Window { retainedRecovery: RecoveryProbe; sharedRecovery: SharedRecoveryProbe } }

async function dirtyScenes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const registry = window.novalistStores.project.getState().getWritingRegistry()!
    return registry.capture().filter(snapshot => registry.isSceneDirty(snapshot)).map(snapshot => snapshot.sceneId)
  })
}

async function retainUnsavedWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const client = window.novalistRpc
    const original = client.request.bind(client)
    const project = window.novalistStores.project
    const stop = project.subscribe(state => { if (state.workspaceRecovering) window.retainedRecovery.recoverySeen = true })
    const probe: RecoveryProbe = { owner: project.getState().getWritingRegistry(), blocked: true,
      recoverySeen: false, commits: [], restore: () => { client.request = original; stop() } }
    window.retainedRecovery = probe
    client.request = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method === 'writing/commit') {
        probe.commits.push(structuredClone((params as [WritingCommitRequest])[0]))
        if (probe.blocked) throw new Error('The recovery fixture is holding unsaved prose.')
      }
      return original<T>(method, params)
    }
  })
}

test('actual backend restart retains dirty canonical prose and undo in main and detached windows', async () => {
  const h = await launchApp('novalist-writing-recovery-')
  const pages: Page[] = [h.page]
  try {
    const book = await seedBook(h, { Chapter: ['Main', 'Detached'] }, 'Recovery fixture', false)
    const chapter = book.chapters[0]
    for (const [index, scene] of chapter.scenes.entries()) {
      await h.rpc('scenes/write', [chapter.guid, scene.id, `<p>Original ${index}.</p>`, `Original ${index}.`])
    }
    await dismissTour(h.page)
    await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
      const shell = window.novalistStores.shell.getState()
      shell.setPaneWritingScope(shell.activePaneId, 'scene')
      await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
    }, { chapterGuid: chapter.guid, sceneId: chapter.scenes[0].id })
    const opened = h.app.waitForEvent('window')
    await h.page.evaluate(({ chapterGuid, sceneId }) => {
      const project = window.novalistStores.project.getState()
      return window.novalist.openPaneWindow({ view: 'write', writingScope: 'scene', projectPath: project.projectPath,
        bookId: project.activeBookId, draftId: project.activeDraftId, chapterGuid, sceneId })
    }, { chapterGuid: chapter.guid, sceneId: chapter.scenes[1].id })
    const second = await opened
    pages.push(second)
    const epoch = await h.page.evaluate(() => window.novalistStores.project.getState().workspaceEpoch)
    expect(epoch).toBeGreaterThan(0)
    for (const [index, page] of pages.entries()) {
      await page.evaluate(async ({ chapter, index }) => {
        const project = window.novalistStores.project.getState()
        await project.openScene(chapter.guid, chapter.scenes[1 - index].id)
        await project.openScene(chapter.guid, chapter.scenes[index].id)
      }, { chapter, index })
      await expect(page.frameLocator('.editor-frame').locator(`[data-writing-scene="${chapter.scenes[index].id}"]`)).toHaveText(`Original ${index}.`)
      await retainUnsavedWrites(page)
      await replaceWritingScene(page, chapter.scenes[index].id, `<p><strong>Pending ${index} after restart.</strong></p>`)
      await expect.poll(() => page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()?.isDirty)).toBe(true)
      await expect.poll(() => dirtyScenes(page)).toEqual([chapter.scenes[index].id])
      await expect(flushWriting(page)).rejects.toThrow('holding unsaved prose')
    }

    // This exits the real temporary backend; the application must launch and restore it.
    await h.page.evaluate(() => window.novalistRpc.notify('system/shutdown'))
    for (const [index, page] of pages.entries()) {
      await expect.poll(() => page.evaluate(() => window.retainedRecovery.recoverySeen)).toBe(true)
      await expect.poll(() => page.evaluate(() => {
        const project = window.novalistStores.project.getState()
        return { epoch: project.workspaceEpoch, busy: project.workspaceBusy, recovering: project.workspaceRecovering, error: project.workspaceRecoveryError }
      })).toEqual({ epoch: 0, busy: false, recovering: false, error: null })
      expect(await page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry() === window.retainedRecovery.owner)).toBe(true)
      const scene = page.frameLocator('.editor-frame').locator(`[data-writing-scene="${chapter.scenes[index].id}"]`)
      await expect(scene).toHaveText(`Pending ${index} after restart.`)
      await expect.poll(() => dirtyScenes(page)).toEqual([chapter.scenes[index].id])
      await scene.click()
      await page.keyboard.press('ControlOrMeta+z')
      await expect(scene).toHaveText(`Original ${index}.`)
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect(scene).toHaveText(`Pending ${index} after restart.`)
      await page.evaluate(() => { window.retainedRecovery.blocked = false })
      await flushWriting(page)
      const requests = await page.evaluate(() => window.retainedRecovery.commits)
      expect(requests.at(-1)!.expectedEpoch).toBe(0)
      expect(requests.at(-1)!.transactionId).toBe(requests[0].transactionId)
      expect(await page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()!.isDirty)).toBe(false)
      await expect.poll(() => dirtyScenes(page)).toEqual([])
    }
    for (const [index, scene] of chapter.scenes.entries()) {
      expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, scene.id])).html).toContain(`<strong>Pending ${index} after restart.</strong>`)
    }
  } finally {
    for (const page of pages) if (!page.isClosed()) await page.evaluate(() => window.retainedRecovery?.restore())
    await h.close()
  }
})

test('actual backend restart reconnects failed shared edits and undo to a recovered Yjs session', async () => {
  const h = await launchApp('novalist-shared-writing-recovery-')
  const remote = new Y.Doc()
  const prose = remote.getText('prose')
  prose.insert(0, 'Base')
  prose.insert(4, '\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
  let refuse = true
  const attempts: string[] = []
  try {
    const book = await seedBook(h, { Chapter: ['Shared recovery', 'Clean tab'] }, 'Shared recovery fixture', false)
    const chapter = book.chapters[0], sceneId = chapter.scenes[0].id
    await dismissTour(h.page)
    await h.page.exposeFunction('readRecoverySharedScene', () => Buffer.from(Y.encodeStateAsUpdate(remote)).toString('base64'))
    await h.page.exposeFunction('writeRecoverySharedScene', (sessionId: string, update: string) => {
      attempts.push(sessionId)
      if (refuse) throw new Error('The recovery fixture is holding unsent shared prose.')
      expect(sessionId).toBe('recovered-session')
      Y.applyUpdate(remote, new Uint8Array(Buffer.from(update, 'base64')))
    })
    await h.page.evaluate(async ({ chapterGuid, sceneId, cleanSceneId }) => {
      const client = window.novalistRpc
      const original = client.request.bind(client)
      const read = Reflect.get(window, 'readRecoverySharedScene') as () => Promise<string>
      const write = Reflect.get(window, 'writeRecoverySharedScene') as (sessionId: string, update: string) => Promise<void>
      window.novalistStores.project.subscribe(state => {
        if (state.workspaceRecovering) {
          window.sharedRecovery.recoverySeen = true
          window.sharedRecovery.sessionId = 'recovered-session'
        }
      })
      window.sharedRecovery = { recoverySeen: false, sessionId: 'original-session', ordinaryWrites: 0 }
      client.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        const args = params as unknown[] | undefined
        if (method === 'collaboration/readScene') return await read() as T
        if (method === 'collaboration/writeScene') return await write(String(args?.[0]), String(args?.[2])) as T
        if (method === 'scenes/write' || method === 'writing/commit') window.sharedRecovery.ordinaryWrites++
        const result = await original<T>(method, params)
        if (method === 'scenes/readPassive' && args?.[3] === sceneId) return { ...result, html: '<p>Base</p>',
          shared: { sessionId: window.sharedRecovery.sessionId, itemId: 'retained-scene', state: await read() } }
        return result
      }
      const shell = window.novalistStores.shell.getState()
      shell.setPaneWritingScope(shell.activePaneId, 'scene')
      await window.novalistStores.project.getState().openScene(chapterGuid, cleanSceneId)
      await window.novalistStores.project.getState().openScene(chapterGuid, sceneId)
    }, { chapterGuid: chapter.guid, sceneId, cleanSceneId: chapter.scenes[1].id })
    const scene = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${sceneId}"]`)
    await expect(scene).toHaveText('Base')
    await scene.click(); await h.page.keyboard.press('End'); await h.page.keyboard.type(' local')
    await expect.poll(() => attempts.includes('original-session')).toBe(true)
    await expect(h.page.locator('.writing-error')).toContainText('Shared edits are still waiting to be saved.')
    expect(prose.toString()).toBe('Base\n')
    prose.insert(0, 'peer ')

    // Restart the real backend; the controlled CRDT endpoint supplies its new session identity.
    await h.page.evaluate(() => window.novalistRpc.notify('system/shutdown'))
    await expect.poll(() => h.page.evaluate(() => {
      const state = window.novalistStores.project.getState()
      return { seen: window.sharedRecovery.recoverySeen, epoch: state.workspaceEpoch, busy: state.workspaceBusy,
        recovering: state.workspaceRecovering, error: state.workspaceRecoveryError }
    })).toEqual({ seen: true, epoch: 0, busy: false, recovering: false, error: null })
    await expect(scene).toHaveText('peer Base local')
    expect(prose.toString()).toBe('peer Base\n')
    await expect.poll(() => attempts.includes('recovered-session')).toBe(true)
    refuse = false
    await h.page.locator('.writing-error').getByRole('button', { name: 'Try again', exact: true }).click()
    await expect.poll(() => prose.toString()).toBe('peer Base local\n')
    await expect(h.page.locator('.writing-error')).toHaveCount(0)
    await scene.click(); await h.page.keyboard.press('ControlOrMeta+z')
    await expect(scene).toHaveText('peer Base')
    await expect.poll(() => prose.toString()).toBe('peer Base\n')
    await h.page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => prose.toString()).toBe('peer Base local\n')
    expect(await h.page.evaluate(() => window.sharedRecovery.ordinaryWrites)).toBe(0)
  } finally {
    refuse = false
    await h.close()
    remote.destroy()
  }
})
