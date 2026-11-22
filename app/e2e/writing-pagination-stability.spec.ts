import { expect, test } from '@playwright/test'
import { dismissTour, enterWriting, launchApp, resizeWindow } from './harness'
import { seedApplicationWritingBook } from './fixtures/writingApplicationBook'
import { revealApplicationScene } from './fixtures/writingApplicationProbe'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

type PaginationWindow = EditorWindow & { repaginatePageView(root: HTMLElement): void }

test('page layout retains native prose nodes, reflows changed geometry and preserves one-step undo', async () => {
  const h = await launchApp('nl-writing-pagination-stability-')
  try {
    const book = await seedApplicationWritingBook(h, 100)
    await h.page.evaluate(root => window.novalistStores.project.getState().openProject(root), book.root)
    await dismissTour(h.page)
    await resizeWindow(h, 1500, 900)
    await enterWriting(h.page)
    await h.page.evaluate(scene => window.novalistStores.project.getState().openScene(scene.chapterGuid, scene.id), book.scenes[0])
    const frame = h.page.frames().find(value => value.url().includes('/editor/editor.html'))!
    const id = book.scenes[0].id
    const root = frame.locator(`[data-writing-scene="${id}"]`)
    await expect(frame.locator('[data-writing-scene]')).toHaveCount(100)
    await expect(frame.locator('body')).toHaveClass(/\bpage-view\b/)
    const readAnnotations = () => h.page.evaluate(scene => {
      const registry = window.novalistStores.project.getState().getWritingRegistry()!
      return registry.getAnnotations({ ...registry.context, chapterGuid: scene.chapterGuid, sceneId: scene.id })
    }, book.scenes[0])
    const annotationsBefore = await readAnnotations()
    expect(annotationsBefore?.comments).toHaveLength(1)
    await revealApplicationScene(frame, id)
    await h.page.keyboard.insertText('x')
    await h.page.waitForTimeout(200)
    await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()!.flush())
    const expected = book.scenes[0].html.replace('w0x0', 'w0x0x')
    const read = () => frame.evaluate(id => (window as unknown as EditorWindow).serializeWritingScene(id), id)
    await expect.poll(read).toBe(expected)
    const caret = await frame.evaluate(() => (window as unknown as EditorWindow).getWritingSelection())
    expect(caret?.focus.offset).toBe(5)
    const retained = await frame.evaluateHandle(id => {
      const scene = (window as unknown as EditorWindow).getWritingSceneRoot(id)!
      return { pages: [...scene.querySelectorAll('.nv-page')], paragraphs: [...scene.querySelectorAll('p')] }
    }, id)
    const initialPages = await root.locator('.nv-page').count()
    expect(initialPages).toBeGreaterThan(1)
    expect(await retained.evaluate(({ pages, paragraphs }, id) => {
      const editor = window as unknown as PaginationWindow
      const scene = editor.getWritingSceneRoot(id)!
      for (let index = 0; index < 20; index++) editor.repaginatePageView(scene)
      return pages.every((page, index) => scene.querySelectorAll('.nv-page')[index] === page) &&
        paragraphs.every((paragraph, index) => scene.querySelectorAll('p')[index] === paragraph)
    }, id)).toBe(true)
    await frame.addStyleTag({ content: `[data-writing-scene="${id}"] p { min-height: 700px; }` })
    await frame.evaluate(id => {
      const editor = window as unknown as PaginationWindow
      editor.repaginatePageView(editor.getWritingSceneRoot(id)!)
    }, id)
    expect(await root.locator('.nv-page').count()).toBeGreaterThan(initialPages)
    expect(await retained.evaluate(({ pages }, id) => (window as unknown as EditorWindow).getWritingSceneRoot(id)!.firstChild === pages[0], id)).toBe(true)
    expect(await frame.evaluate(() => (window as unknown as EditorWindow).getWritingSelection())).toEqual(caret)
    expect(await read()).toBe(expected)
    await h.page.keyboard.press('Control+z')
    await expect.poll(read).toBe(book.scenes[0].html)
    await expect(root.locator('[data-comment-id="fixture-comment-0"]')).toHaveCount(1)
    expect(await readAnnotations()).toEqual(annotationsBefore)
    await retained.dispose()
  } finally { await h.close() }
})
