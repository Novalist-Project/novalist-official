import { expect, test } from '@playwright/test'
import { launchApp, seedBook } from './harness'
import { flushWriting, replaceWritingScene } from './writingTestActions'
import type { WritingCommitRequest, WritingCommitResult } from '../src/renderer/src/views/editor/writingTypes'

test('mobile manuscript successors wait for and inherit the preceding save hash', async () => {
  const h = await launchApp('novalist-manuscript-save-order-', { NOVALIST_FORCE_MOBILE: '1' })
  try {
    const book = await seedBook(h, { Chapter: ['Scene'] })
    const sceneId = book.chapters[0].scenes[0].id

    const observed = await h.page.evaluate(
      async ({ sceneId }) => {
        const manuscript = window.novalistStores.manuscript.getState()
        await manuscript.load()
        const rpc = window.novalistRpc
        const originalRequest = rpc.request.bind(rpc)
        const calls: unknown[][] = []
        let releaseFirst!: () => void
        let markFirstStarted!: () => void
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        const firstStarted = new Promise<void>((resolve) => {
          markFirstStarted = resolve
        })

        rpc.request = (async <T,>(method: string, params?: unknown): Promise<T> => {
          if (method !== 'scenes/write') return originalRequest<T>(method, params)
          const index = calls.length
          calls.push(params as unknown[])
          if (index === 0) {
            markFirstStarted()
            await firstGate
          }
          return {
            sceneId,
            wordCount: index + 1,
            hash: index === 0 ? 'hash-after-first' : 'hash-after-second',
            conflicted: false,
            diskHtml: null
          } as T
        }) as typeof rpc.request

        try {
          manuscript.onSceneContentChanged(sceneId, '<p>first</p>', 'first', 1)
          const first = manuscript.flushPendingSave()
          await firstStarted

          window.novalistStores.manuscript
            .getState()
            .onSceneContentChanged(sceneId, '<p>second</p>', 'second', 1)
          const second = window.novalistStores.manuscript.getState().flushPendingSave()
          await new Promise((resolve) => setTimeout(resolve, 0))
          const callsBeforeRelease = calls.length

          releaseFirst()
          await Promise.all([first, second])
          return { callsBeforeRelease, calls }
        } finally {
          releaseFirst()
          rpc.request = originalRequest
        }
      },
      { sceneId }
    )

    expect(observed.callsBeforeRelease).toBe(1)
    expect(observed.calls).toHaveLength(2)
    expect(observed.calls[1][4]).toBe('hash-after-first')
  } finally {
    await h.close()
  }
})

test('mobile editor-first shutdown exposes a manuscript conflict instead of overwriting', async () => {
  const h = await launchApp('novalist-manuscript-overlap-', { NOVALIST_FORCE_MOBILE: '1' })
  try {
    const book = await seedBook(h, { Chapter: ['Scene'] })
    const chapterGuid = book.chapters[0].guid
    const sceneId = book.chapters[0].scenes[0].id

    const result = await h.page.evaluate(
      async ({ chapterGuid, sceneId }) => {
        const project = window.novalistStores.project.getState()
        await project.openScene(chapterGuid, sceneId)
        await window.novalistStores.manuscript.getState().load()

        const current = window.novalistStores.project.getState()
        current.onEditorContentChanged(
          current.activeEditorPaneId!,
          '<p>editor version</p>',
          'editor version'
        )
        window.novalistStores.manuscript
          .getState()
          .onSceneContentChanged(sceneId, '<p>manuscript version</p>', 'manuscript version', 2)

        // This is the dangerous callback order: the checked EditorFrame save is
        // acknowledged first, then Manuscript tries to save its competing copy.
        await window.novalistStores.project.getState().flushPendingSave()
        let message = ''
        try {
          await window.novalistStores.manuscript.getState().flushPendingSave()
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        const conflict = window.novalistStores.project.getState().sceneConflict
        const beforeResolution = (
          await window.novalistRpc.request<{ html: string }>('scenes/read', [chapterGuid, sceneId])
        ).html

        await window.novalistStores.project
          .getState()
          .resolveSceneConflict('<p>chosen resolution</p>')
        // The rejected manuscript payload was retired by resolution; a later
        // updater flush must not submit it over the chosen text.
        await window.novalistStores.manuscript.getState().flushPendingSave()
        const afterResolution = (
          await window.novalistRpc.request<{ html: string }>('scenes/read', [chapterGuid, sceneId])
        ).html
        return { message, conflict, beforeResolution, afterResolution }
      },
      { chapterGuid, sceneId }
    )

    // The message is localized; the contract is that this flush cannot report
    // success while the conflict it exposed is still unresolved.
    expect(result.message).not.toBe('')
    expect(result.conflict?.mine).toBe('<p>manuscript version</p>')
    expect(result.conflict?.theirs).toBe('<p>editor version</p>')
    expect(result.beforeResolution).toBe('<p>editor version</p>')
    expect(result.afterResolution).toBe('<p>chosen resolution</p>')
  } finally {
    await h.close()
  }
})

interface WritingSaveOrderProbe {
  calls: WritingCommitRequest[]
  firstHash: string | null
  failure: string | null
  done: boolean
  release(): void
  restore(): void
}
declare global { interface Window { writingSaveOrder: WritingSaveOrderProbe } }

test('desktop canonical successors wait for the preceding acknowledgement and inherit its saved hash', async () => {
  const h = await launchApp('novalist-writing-save-order-')
  try {
    const book = await seedBook(h, { Chapter: ['Scene'] })
    const chapter = book.chapters[0], scene = chapter.scenes[0]
    await h.page.evaluate(({ chapter, scene }) => window.novalistStores.project.getState().openScene(chapter, scene), { chapter: chapter.guid, scene: scene.id })
    await h.page.evaluate(() => {
      const rpc = window.novalistRpc
      const original = rpc.request.bind(rpc)
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const probe: WritingSaveOrderProbe = { calls: [], firstHash: null, failure: null, done: false,
        release, restore: () => { release(); rpc.request = original } }
      window.writingSaveOrder = probe
      rpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method !== 'writing/commit') return original<T>(method, params)
        const first = probe.calls.length === 0
        probe.calls.push(structuredClone((params as [WritingCommitRequest])[0]))
        if (first) await gate
        const result = await original<WritingCommitResult>(method, params)
        if (first && result.status === 'committed') probe.firstHash = result.hashes[0].hash
        return result as T
      }
    })
    await replaceWritingScene(h.page, scene.id, '<p>First revision.</p>')
    await h.page.waitForFunction(() => window.novalistStores.project.getState().getWritingRegistry()?.isDirty)
    await h.page.evaluate(() => {
      void window.novalistStores.project.getState().getWritingRegistry()!.flush()
        .catch(error => { window.writingSaveOrder.failure = String(error) })
        .finally(() => { window.writingSaveOrder.done = true })
    })
    await expect.poll(() => h.page.evaluate(() => window.writingSaveOrder.calls.length)).toBe(1)
    await replaceWritingScene(h.page, scene.id, '<p>Second revision.</p>')
    expect(await h.page.evaluate(() => window.writingSaveOrder.calls.length)).toBe(1)
    await h.page.evaluate(() => window.writingSaveOrder.release())
    await expect.poll(() => h.page.evaluate(() => window.writingSaveOrder.done)).toBe(true)
    const result = await h.page.evaluate(() => ({ calls: window.writingSaveOrder.calls, firstHash: window.writingSaveOrder.firstHash, failure: window.writingSaveOrder.failure }))
    expect(result.failure).toBeNull()
    expect(result.calls).toHaveLength(2)
    expect(result.firstHash).not.toBeNull()
    expect(result.calls[1].changes[0].expectedHash).toBe(result.firstHash)
    expect(result.calls[1].changes[0].beforeHtml).toContain('First revision.')
    expect((await h.rpc<{ html: string }>('scenes/readPassive', [result.calls[1].changes[0].ref.bookId, result.calls[1].changes[0].ref.draftId, chapter.guid, scene.id])).html).toContain('Second revision.')
  } finally {
    await h.page.evaluate(() => window.writingSaveOrder?.restore())
    await h.close()
  }
})

test('desktop Scene and Manuscript scopes retain one owner and never submit competing legacy saves', async () => {
  const h = await launchApp('novalist-writing-scope-save-')
  try {
    const book = await seedBook(h, { Chapter: ['Scene'] })
    const chapter = book.chapters[0], scene = chapter.scenes[0]
    await h.page.evaluate(({ chapter, scene }) => window.novalistStores.project.getState().openScene(chapter, scene), { chapter: chapter.guid, scene: scene.id })
    const calls: string[] = []
    await h.page.exposeFunction('recordWritingSaveMethod', (method: string) => { calls.push(method) })
    await h.page.evaluate(() => {
      const request = window.novalistRpc.request.bind(window.novalistRpc)
      const probe = window as unknown as { recordWritingSaveMethod(method: string): Promise<void>; retainedWritingOwner: unknown }
      probe.retainedWritingOwner = window.novalistStores.project.getState().getWritingRegistry()
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (['writing/commit', 'scenes/write', 'manuscript/get'].includes(method)) await probe.recordWritingSaveMethod(method)
        return request<T>(method, params)
      }
      const shell = window.novalistStores.shell.getState()
      shell.setPaneWritingScope(shell.activePaneId, 'scene')
    })
    await replaceWritingScene(h.page, scene.id, '<p>Scene revision.</p>')
    await flushWriting(h.page)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('manuscript'))
    await replaceWritingScene(h.page, scene.id, '<p>Manuscript revision.</p>')
    await flushWriting(h.page)
    expect(await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry() ===
      (window as unknown as { retainedWritingOwner: unknown }).retainedWritingOwner)).toBe(true)
    expect(calls).toEqual(['writing/commit', 'writing/commit'])
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, scene.id])).html).toContain('Manuscript revision.')
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
  } finally { await h.close() }
})
