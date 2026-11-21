import { test, expect, type Locator } from '@playwright/test'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

async function seedImageScenes(h: Harness) {
  const book = await seedBook(h, { One: ['A', 'B'] }, 'Spec', false)
  const chapter = book.chapters[0]
  for (const scene of chapter.scenes) {
    await h.rpc('scenes/write', [chapter.guid, scene.id, '<p>First</p><p>Second</p><p>Third</p>', 'First Second Third'])
  }
  await dismissTour(h.page)
  await h.page.evaluate(chapter =>
    window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
  await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
  await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toHaveCount(1)
  return chapter
}

async function shape(scene: Locator): Promise<string[]> {
  return scene.evaluate(element => Array.from(element.querySelectorAll('p')).map(paragraph =>
    paragraph.querySelector('img') ? '[img]' : (paragraph.textContent ?? '').trim()))
}

async function rememberImageTargetThroughMenu(h: Harness, scene: Locator): Promise<void> {
  // Keep the native picker pending while presentation changes move the prose.
  await h.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise<{ canceled: boolean; filePaths: string[] }>(resolve => {
      Object.assign(globalThis, { cancelImagePicker: () => resolve({ canceled: true, filePaths: [] }) })
    })
  })
  await scene.evaluate(element => {
    const document = element.ownerDocument
    document.getElementById('editor')!.focus()
    const paragraph = element.querySelectorAll('p')[1]
    const range = document.createRange()
    range.setStart(paragraph.firstChild ?? paragraph, 0)
    range.collapse(true)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  const frame = h.page.frameLocator('.editor-frame')
  await scene.locator('p').nth(1).click({ button: 'right', position: { x: 8, y: 8 } })
  const group = frame.locator('.cm-parent', { has: frame.locator('.cm-item[data-action="insertImage"]') })
  await expect(group).toBeVisible()
  await group.hover()
  await frame.locator('.cm-item[data-action="insertImage"]').click()
  await expect.poll(() => h.app.evaluate(() =>
    typeof (globalThis as unknown as { cancelImagePicker?: unknown }).cancelImagePicker
  )).toBe('function')
  expect(await scene.evaluate(element => {
    const saved = (window as unknown as { NovalistEditorState: { imageTargetBlock: { text: string; tag: string; index: number; scene: string } | null } }).NovalistEditorState.imageTargetBlock
    return saved && { text: saved.text, tag: saved.tag, index: saved.index, inScene: saved.scene === element.getAttribute('data-writing-scene') }
  })).toEqual({ text: 'Second', tag: 'P', index: 1, inScene: true })
}

async function rebuildPresentationWithoutSelection(scene: Locator, paged: boolean): Promise<void> {
  await scene.evaluate(() => {
    window.getSelection()?.removeAllRanges()
    const frame = window as unknown as EditorWindow
    frame.setPageView(false)
    frame.setGrammarIssues(JSON.stringify([{ offset: 6, length: 6, type: 'grammar', message: 'Test issue', replacements: [] }]))
  })
  await expect(scene.locator('.nv-page')).toHaveCount(0)
  await expect(scene.locator('p').nth(1).locator('.grammar-issue')).toHaveText('Second')
  await scene.evaluate(() => {
    const frame = window as unknown as EditorWindow
    frame.setGrammarIssues('[]')
    frame.setPageView(true)
  })
  await expect(scene.locator('.grammar-issue')).toHaveCount(0)
  await expect(scene.locator('.nv-page')).not.toHaveCount(0)
  if (!paged) {
    await scene.evaluate(() => (window as unknown as EditorWindow).setPageView(false))
    await expect(scene.locator('.nv-page')).toHaveCount(0)
  }
  await scene.evaluate(() => window.getSelection()?.removeAllRanges())
  expect(await scene.evaluate(() => window.getSelection()?.rangeCount)).toBe(0)
}

async function finishPickerAndInsert(h: Harness, scene: Locator, alt: string): Promise<void> {
  await h.app.evaluate(() =>
    (globalThis as unknown as { cancelImagePicker(): void }).cancelImagePicker())
  await scene.evaluate((_, alt) =>
    (window as unknown as EditorWindow).insertImageAtCaret('Images/plan.png', alt), alt)
}

for (const paged of [false, true]) {
  test('an image survives a presentation rebuild at the remembered caret' + (paged ? ' in page view' : ''), async () => {
    const h = await launchApp('nl-insert-image-')
    try {
      const chapter = await seedImageScenes(h)
      const scene = h.page.frameLocator('.editor-frame').locator('[data-writing-scene="' + chapter.scenes[0].id + '"]')
      await expect(scene.locator('p')).toHaveText(['First', 'Second', 'Third'])
      await scene.evaluate((_, paged) => (window as unknown as EditorWindow).setPageView(paged), paged)
      if (paged) await expect(scene.locator('.nv-page')).not.toHaveCount(0)
      await rememberImageTargetThroughMenu(h, scene)
      await rebuildPresentationWithoutSelection(scene, paged)
      const alt = paged ? '' : 'the map'
      await finishPickerAndInsert(h, scene, alt)
      expect(await shape(scene)).toEqual(['First', 'Second', '[img]', 'Third'])
      await expect(scene.locator('img')).toHaveAttribute('alt', alt)
      await expect(scene.locator('img')).toHaveAttribute('data-nv-src', 'Images/plan.png')
      expect(await scene.locator('img').evaluate(element => !!element.closest('.nv-page'))).toBe(paged)
    } finally { await h.close() }
  })
}

test('a remembered image target cannot move to identical prose in another scene', async () => {
  const h = await launchApp('nl-insert-image-stale-')
  try {
    const chapter = await seedImageScenes(h)
    const frame = h.page.frameLocator('.editor-frame')
    const first = frame.locator('[data-writing-scene="' + chapter.scenes[0].id + '"]')
    await expect(first.locator('p')).toHaveText(['First', 'Second', 'Third'])
    await rememberImageTargetThroughMenu(h, first)
    await h.page.evaluate(chapter =>
      window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[1].id), chapter)
    const second = frame.locator('[data-writing-scene="' + chapter.scenes[1].id + '"]')
    await expect(second.locator('p')).toHaveText(['First', 'Second', 'Third'])
    await expect(first).toHaveCount(0)
    await second.evaluate(() => window.getSelection()?.removeAllRanges())
    await finishPickerAndInsert(h, second, 'stale image')
    expect(await shape(second)).toEqual(['First', 'Second', 'Third'])
    await expect(frame.locator('#editor img')).toHaveCount(0)
    await h.page.evaluate(chapter =>
      window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
    await expect(first.locator('p')).toHaveText(['First', 'Second', 'Third'])
    await expect(first.locator('img')).toHaveCount(0)
  } finally { await h.close() }
})
