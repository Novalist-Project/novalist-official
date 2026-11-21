import { expect, test, type Locator } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dismissTour, launchApp, seedBook } from './harness'
import { flushWriting, replaceWritingScene } from './writingTestActions'

test('refocusing reloads clean scene text and counts external edits in unopened scenes', async () => {
  const h = await launchApp('nl-external-refresh-')
  try {
    const book = await seedBook(h, { One: ['Open scene', 'Other scene'] }, 'Spec', false)
    await dismissTour(h.page)
    const { guid, scenes } = book.chapters[0]
    await h.rpc('scenes/write', [guid, scenes[0].id, '<p>Original text.</p>\n<p>Another paragraph.</p>', 'Original text. Another paragraph.'])
    await h.page.evaluate(({ guid, id }) => window.novalistStores.project.getState().openScene(guid, id), { guid, id: scenes[0].id })
    const editor = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${scenes[0].id}"]`).first()
    await expect(editor).toHaveText('Original text.Another paragraph.')
    const { projectPath } = await h.rpc<{ projectPath: string }>('project/getState')
    const paths = readdirSync(projectPath, { recursive: true }).filter(path => String(path).endsWith('.novalist'))
      .map(path => join(projectPath, String(path))).filter(path => statSync(path).isFile())
    const first = paths.find(path => readFileSync(path, 'utf8').includes(scenes[0].id))!
    const other = paths.find(path => readFileSync(path, 'utf8').includes(scenes[1].id))!
    writeFileSync(first, `<!--nv v=1 id=${scenes[0].id} -->\n<p>Changed externally.</p><p>Four words.</p>`)
    writeFileSync(other, `<!--nv v=1 id=${scenes[1].id} -->\n<p>Another external scene has five.</p>`)
    await h.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(editor).toHaveText('Changed externally.Four words.')
    await expect(h.page.locator('.binder-scene-words')).toHaveText(['4', '5'])
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
    await focusSceneEnd(editor)
    await h.page.keyboard.type(' Added.')
    await expect(editor).toHaveText('Changed externally.Four words. Added.')
    await flushWriting(h.page)
    await expect.poll(() => readFileSync(first, 'utf8')).toContain('Added.')
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
  } finally { await h.close() }
})

test('refocusing preserves unsaved text and opens a conflict without overwriting disk', async () => {
  const h = await launchApp('nl-external-dirty-')
  try {
    const book = await seedBook(h, { One: ['Scene'] }, 'Spec', false)
    await dismissTour(h.page)
    const { guid, scenes } = book.chapters[0]
    await h.rpc('scenes/write', [guid, scenes[0].id, '<p>Original.</p>', 'Original.'])
    await h.page.evaluate(({ guid, id }) => window.novalistStores.project.getState().openScene(guid, id), { guid, id: scenes[0].id })
    const editor = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${scenes[0].id}"]`).first()
    await expect(editor).toHaveText('Original.')
    const { projectPath } = await h.rpc<{ projectPath: string }>('project/getState')
    const path = readdirSync(projectPath, { recursive: true }).map(path => join(projectPath, String(path)))
      .find(path => path.endsWith('.novalist') && statSync(path).isFile())!
    await replaceWritingScene(h.page, scenes[0].id, '<p>My unsaved words.</p>')
    writeFileSync(path, `<!--nv v=1 id=${scenes[0].id} -->\n<p>Changed elsewhere.</p>`)
    await h.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(h.page.locator('.scene-conflict-card')).toBeVisible({ timeout: 1500 })
    await expect(editor).toHaveText('My unsaved words.')
    expect(readFileSync(path, 'utf8')).toContain('Changed elsewhere.')
    expect(readFileSync(path, 'utf8')).not.toContain('My unsaved words.')
    await h.page.locator('.scene-conflict-card .dialog-actions .danger').click()
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
    await expect(editor).toHaveText('My unsaved words.')
    await expect.poll(() => readFileSync(path, 'utf8')).toContain('My unsaved words.')
    await focusSceneEnd(editor)
    await h.page.keyboard.type(' After resolution.')
    await expect(editor).toHaveText('My unsaved words. After resolution.')
    await flushWriting(h.page)
    expect(readFileSync(path, 'utf8')).toContain('After resolution.')
  } finally { await h.close() }
})

test('a delayed focus refresh cannot regress a newer save or its outline count', async () => {
  const h = await launchApp('nl-external-save-race-')
  try {
    const book = await seedBook(h, { One: ['Scene'] }, 'Spec', false)
    await dismissTour(h.page)
    const { guid, scenes } = book.chapters[0]
    await h.rpc('scenes/write', [guid, scenes[0].id, '<p>Original text.</p>', 'Original text.'])
    await h.page.evaluate(({ guid, id }) => window.novalistStores.project.getState().openScene(guid, id), { guid, id: scenes[0].id })
    const editor = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${scenes[0].id}"]`).first()
    await expect(editor).toHaveText('Original text.')
    await h.page.evaluate(() => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      const state = window as unknown as { refreshHeld: boolean; refreshReleased: boolean; releaseRefresh: () => void }
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      state.releaseRefresh = () => { window.novalistRpc.request = original; release() }
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        const result = await original<T>(method, params)
        if (method === 'scenes/refresh' || method === 'scenes/readPassive') {
          state.refreshHeld = true
          await gate
          state.refreshReleased = true
        }
        return result
      }
      window.dispatchEvent(new Event('focus'))
    })
    await h.page.waitForFunction(() => (window as unknown as { refreshHeld: boolean }).refreshHeld)
    await replaceWritingScene(h.page, scenes[0].id, '<p>The newest saved scene contains exactly nine whole words.</p>')
    await h.page.waitForFunction(() => window.novalistStores.project.getState().getWritingRegistry()?.isDirty)
    await flushWriting(h.page)
    await expect(h.page.locator('.binder-scene-words')).toHaveText('9')
    await h.page.evaluate(() => (window as unknown as { releaseRefresh: () => void }).releaseRefresh())
    await h.page.waitForFunction(() => (window as unknown as { refreshReleased: boolean }).refreshReleased)
    await expect(h.page.locator('.binder-scene-words')).toHaveText('9')
    await expect(editor).toHaveText('The newest saved scene contains exactly nine whole words.')
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
  } finally { await h.close() }
})

test('focus refresh updates Manuscript and preserves its unsaved edits on conflict', async () => {
  const h = await launchApp('nl-external-manuscript-')
  try {
    const book = await seedBook(h, { One: ['Scene'] }, 'Spec', false)
    await dismissTour(h.page)
    const { guid, scenes } = book.chapters[0]
    await h.rpc('scenes/write', [guid, scenes[0].id, '<p>Original text.</p>', 'Original text.'])
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('manuscript'))
    const prose = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${scenes[0].id}"]`).first()
    await expect(prose).toHaveText('Original text.')
    const { projectPath } = await h.rpc<{ projectPath: string }>('project/getState')
    const path = readdirSync(projectPath, { recursive: true }).map(path => join(projectPath, String(path)))
      .find(path => path.endsWith('.novalist') && statSync(path).isFile())!
    writeFileSync(path, `<!--nv v=1 id=${scenes[0].id} -->\n<p>External manuscript edit.</p>`)
    await h.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(prose).toHaveText('External manuscript edit.')
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
    await replaceWritingScene(h.page, scenes[0].id, '<p>My manuscript draft.</p>')
    writeFileSync(path, `<!--nv v=1 id=${scenes[0].id} -->\n<p>Another external edit.</p>`)
    await h.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(h.page.locator('.scene-conflict-card')).toBeVisible()
    await expect(prose).toHaveText('My manuscript draft.')
    expect(readFileSync(path, 'utf8')).toContain('Another external edit.')
    await h.page.evaluate(() => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      const state = window as unknown as { resolutionRequests: unknown[] }
      state.resolutionRequests = []
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        const result = await original<T>(method, params)
        if (method === 'writing/resolveConflict') {
          state.resolutionRequests.push(structuredClone(params))
          if (state.resolutionRequests.length === 1) throw new Error('Injected lost resolution reply')
          window.novalistRpc.request = original
        }
        return result
      }
    })
    await h.page.getByRole('button', { name: 'Take all from disk', exact: true }).click()
    await h.page.locator('.scene-conflict-card .dialog-actions .danger').click()
    await expect(h.page.locator('.scene-conflict-pending')).toHaveText('Another external edit.')
    await h.page.getByRole('button', { name: 'Decide later', exact: true }).click()
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
    await h.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(h.page.locator('.scene-conflict-pending')).toHaveText('Another external edit.')
    await h.page.locator('.scene-conflict-card .dialog-actions .danger').click()
    await expect(h.page.locator('.scene-conflict-card')).toHaveCount(0)
    const requests = await h.page.evaluate(() => (window as unknown as { resolutionRequests: unknown[] }).resolutionRequests)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    await expect(prose).toHaveText('Another external edit.')
    await flushWriting(h.page)
    expect(readFileSync(path, 'utf8')).toContain('Another external edit.')
  } finally { await h.close() }
})

async function focusSceneEnd(scene: Locator): Promise<void> {
  await scene.evaluate(element => {
    const document = element.ownerDocument
    document.getElementById('editor')!.focus()
    const range = document.createRange()
    range.selectNodeContents(element.lastElementChild ?? element)
    range.collapse(false)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
}
