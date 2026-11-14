import { expect, test } from '@playwright/test'
import * as Y from 'yjs'
import { dismissTour, launchApp, seedBook } from './harness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import type { AnnotationChange } from '../src/renderer/src/views/editor/writingTypes'

declare global {
  interface Window {
    sharedPersistenceTest: {
      read(): Promise<string>
      write(update: string): Promise<void>
      ordinaryWrites: number
      annotationIds?: string[]
    }
  }
}

test('failed Manuscript edits survive reopening and switching to the scene editor without ordinary writes', async () => {
  const h = await launchApp('nl-shared-manuscript-retention-')
  const document = new Y.Doc()
  const prose = document.getText('prose')
  prose.insert(0, 'The story.')
  prose.insert(prose.length, '\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
  let refuse = true
  let attempts = 0
  try {
    const book = await seedBook(h, { Chapter: ['Shared'] }, 'Spec', false)
    const chapter = book.chapters[0]
    await dismissTour(h.page)
    await h.page.exposeFunction('readSharedTestScene', () => Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'))
    await h.page.exposeFunction('writeSharedTestScene', (update: string) => {
      attempts++
      if (refuse) throw new Error('Temporary storage failure.')
      Y.applyUpdate(document, new Uint8Array(Buffer.from(update, 'base64')))
    })
    await h.page.evaluate(({ chapter, initial }) => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      const read = Reflect.get(window, 'readSharedTestScene') as () => Promise<string>
      const write = Reflect.get(window, 'writeSharedTestScene') as (update: string) => Promise<void>
      window.sharedPersistenceTest = { read, write, ordinaryWrites: 0 }
      const shared = { sessionId: 'session-one', itemId: 'item-one', state: initial }
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        const args = params as unknown[] | undefined
        if (method === 'collaboration/readScene') return await read() as T
        if (method === 'collaboration/writeScene') return await write(String(args?.[2])) as T
        if (method === 'scenes/write' || method === 'writing/commit') window.sharedPersistenceTest.ordinaryWrites++
        const result = await original<T>(method, params)
        if (method === 'scenes/readPassive' && args?.[3] === chapter.scenes[0].id) return { ...result, html: '<p>The story.</p>', shared }
        return result
      }
      window.novalistStores.shell.getState().setMainView('manuscript')
    }, { chapter, initial: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64') })
    const editor = h.page.frameLocator('iframe[title="editor"]').locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    await expect(editor).toHaveText('The story.')
    await editor.click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' More.')
    await expect.poll(() => attempts).toBeGreaterThan(0)
    await expect(h.page.locator('.writing-error')).toContainText('Shared edits are still waiting to be saved.')
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('dashboard'))
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('manuscript'))
    await expect(editor).toHaveText('The story. More.')
    await editor.click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' Again.')
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
    await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
    const sceneEditor = h.page.frameLocator('iframe[title="editor"]').locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    await expect(sceneEditor).toHaveText('The story. More. Again.')
    refuse = false
    await h.page.locator('.writing-error').getByRole('button', { name: 'Try again', exact: true }).click()
    await expect.poll(() => prose.toString()).toBe('The story. More. Again.\n')
    await expect(h.page.getByRole('alert')).toHaveCount(0)
    expect(await h.page.evaluate(() => window.sharedPersistenceTest.ordinaryWrites)).toBe(0)
  } finally { await h.close(); document.destroy() }
})

test('the normal editor retains failed shared edits and saves CRDT updates without HTML overwrites', async () => {
  const h = await launchApp('nl-shared-editor-')
  const document = new Y.Doc()
  const prose = document.getText('prose')
  prose.insert(0, 'The story.')
  prose.insert(prose.length, '\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
  let refuse = true
  let attempts = 0
  try {
    const book = await seedBook(h, { Chapter: ['Shared', 'Ordinary'] }, 'Spec', false)
    const chapter = book.chapters[0]
    await dismissTour(h.page)
    await h.page.exposeFunction('readSharedTestScene', () => Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'))
    await h.page.exposeFunction('writeSharedTestScene', (update: string) => {
      attempts++
      if (refuse) throw new Error('Temporary storage failure.')
      Y.applyUpdate(document, new Uint8Array(Buffer.from(update, 'base64')))
    })
    await h.page.evaluate(({ chapter, initial }) => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      const read = Reflect.get(window, 'readSharedTestScene') as () => Promise<string>
      const write = Reflect.get(window, 'writeSharedTestScene') as (update: string) => Promise<void>
      window.sharedPersistenceTest = { read, write, ordinaryWrites: 0 }
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        const args = params as unknown[] | undefined
        if (method === 'collaboration/readScene') return await read() as T
        if (method === 'collaboration/writeScene') return await write(String(args?.[2])) as T
        if (method === 'scenes/write' && args?.[1] === chapter.scenes[0].id) window.sharedPersistenceTest.ordinaryWrites++
        if (method === 'writing/commit' && (args?.[0] as { changes: { ref: { sceneId: string } }[] }).changes.some(change => change.ref.sceneId === chapter.scenes[0].id))
          window.sharedPersistenceTest.ordinaryWrites++
        const result = await original<T>(method, params)
        if (method === 'scenes/readPassive' && args?.[3] === chapter.scenes[0].id) {
          return { ...result, html: '<p>The story.</p>', shared: { sessionId: 'session-one', itemId: 'item-one', state: initial } }
        }
        return result
      }
    }, { chapter, initial: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64') })
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
    await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
    const editor = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    await expect(editor).toHaveText('The story.')
    await editor.click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' More.')
    await expect.poll(() => attempts).toBeGreaterThan(0)
    await expect(h.page.locator('.writing-error')).toContainText('Shared edits are still waiting to be saved.')
    const refused = await h.page.evaluate(async () => {
      try { await window.novalistStores.project.getState().closeProject(); return false }
      catch { return true }
    })
    expect(refused).toBe(true)
    expect(await h.page.evaluate(() => window.novalistStores.project.getState().isLoaded)).toBe(true)
    expect(prose.toString()).toBe('The story.\n')
    await h.page.evaluate(() => window.novalistStores.settings.getState().update('global', { language: 'de' }))
    await expect(editor).toHaveText('The story. More.')
    await editor.click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' Again.')
    await h.page.evaluate(() => window.novalistStores.settings.getState().update('global', { language: 'en' }))
    await expect(editor).toHaveText('The story. More. Again.')
    expect(prose.toString()).toBe('The story.\n')
    const stillRefused = await h.page.evaluate(async () => {
      try { await window.novalistStores.project.getState().closeProject(); return false }
      catch { return true }
    })
    expect(stillRefused).toBe(true)
    const attemptsBeforeRetry = attempts
    refuse = false
    await h.page.locator('.writing-error').getByRole('button', { name: 'Try again', exact: true }).click()
    await expect.poll(() => prose.toString()).toBe('The story. More. Again.\n')
    expect(attempts - attemptsBeforeRetry).toBeLessThanOrEqual(4)
    await expect(h.page.getByRole('alert')).toHaveCount(0)
    expect(await h.page.evaluate(() => window.sharedPersistenceTest.ordinaryWrites)).toBe(0)
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[1].id), chapter)
    const ordinary = h.page.frameLocator('iframe[title="editor"]').locator(`[data-writing-scene="${chapter.scenes[1].id}"]`)
    await expect(editor).toHaveCount(0)
    await ordinary.click()
    await h.page.keyboard.type('An ordinary scene.')
    await expect(ordinary).toHaveText('An ordinary scene.')
    await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()!.flush())
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, chapter.scenes[1].id])).html).toContain('An ordinary scene.')
  } finally {
    await h.close()
    document.destroy()
  }
})

test('switching into a shared scene loads its own annotations before saving a new comment', async () => {
  const h = await launchApp('nl-shared-annotations-')
  const document = new Y.Doc()
  document.getText('prose').insert(0, 'Shared prose.')
  document.getText('prose').insert(13, '\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
  try {
    const book = await seedBook(h, { Chapter: ['Ordinary', 'Shared'] }, 'Spec', false)
    const chapter = book.chapters[0]
    for (const [index, scene] of chapter.scenes.entries()) await h.rpc('scenes/setAnnotations', [chapter.guid, scene.id,
      [{ id: `existing-${index}`, anchorText: '', text: `Comment ${index}`, resolved: false }], []])
    await dismissTour(h.page)
    await h.page.evaluate(({ chapter, initial }) => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      window.sharedPersistenceTest = { read: async () => initial, write: async () => {}, ordinaryWrites: 0 }
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'collaboration/readScene') return initial as T
        if (method === 'collaboration/writeScene') return undefined as T
        if (method === 'writing/commitSharedAnnotations') {
          const request = (params as [{ transactionId: string; changes: AnnotationChange[] }])[0]
          const annotations = await Promise.all(request.changes.map(async change => {
            await original('scenes/setAnnotations', [change.ref.chapterGuid, change.ref.sceneId, change.after.comments, change.after.footnotes])
            return { ref: change.ref, annotations: change.after }
          }))
          return { status: 'committed', operationId: request.transactionId, annotations } as T
        }
        const result = await original<T>(method, params)
        if (method === 'scenes/readPassive' && (params as unknown[])[3] === chapter.scenes[1].id)
          return { ...result, html: '<p>Shared prose.</p>', shared: { sessionId: 'session', itemId: 'item', state: initial } }
        return result
      }
    }, { chapter, initial: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64') })
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
    const frame = h.page.frameLocator('iframe[title="editor"]')
    const ordinary = frame.locator(`[data-writing-scene="${chapter.scenes[0].id}"]`)
    await expect(ordinary).toBeVisible()
    await h.page.evaluate(() => {
      const editor = window.document.querySelector<HTMLIFrameElement>('.editor-frame')!.contentWindow as EditorWindow
      const setComments = editor.setCommentsData.bind(editor)
      editor.setCommentsData = data => {
        window.sharedPersistenceTest.annotationIds = data.map(comment => comment.id)
        setComments(data)
      }
    })
    await frame.locator(`[data-writing-scene="${chapter.scenes[1].id}"]`).click()
    await expect.poll(() => h.page.evaluate(() => window.sharedPersistenceTest.annotationIds)).toEqual(['existing-1'])
    await ordinary.click()
    await expect.poll(() => h.page.evaluate(() => window.sharedPersistenceTest.annotationIds)).toEqual(['existing-0'])
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[1].id), chapter)
    await frame.locator(`[data-writing-scene="${chapter.scenes[1].id}"]`).click()
    await expect.poll(() => h.page.evaluate(() => window.sharedPersistenceTest.annotationIds)).toEqual(['existing-1'])
    await h.page.evaluate(sceneId => {
      const editor = window.document.querySelector<HTMLIFrameElement>('.editor-frame')!.contentWindow as EditorWindow
      editor.getSelection()!.selectAllChildren(editor.document.querySelector(`[data-writing-scene="${sceneId}"] p`)!)
      editor.addCommentToSelection('new-shared-comment')
    }, chapter.scenes[1].id)
    await expect.poll(async () => (await h.rpc<{ comments: { id: string }[] }>('scenes/getAnnotations', [chapter.guid, chapter.scenes[1].id])).comments.map(comment => comment.id))
      .toEqual(['existing-1', 'new-shared-comment'])
    expect((await h.rpc<{ comments: { id: string }[] }>('scenes/getAnnotations', [chapter.guid, chapter.scenes[0].id])).comments.map(comment => comment.id))
      .toEqual(['existing-0'])
  } finally {
    await h.close()
    document.destroy()
  }
})
