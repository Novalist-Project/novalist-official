import { expect, test } from '@playwright/test'
import { dismissTour, enterWriting, launchApp, seedBook } from './harness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

const cases: { html: string; offset: number; all?: boolean }[] = [
  { html: '<p>First sentence.</p><p>Following paragraph.</p>', offset: 15 },
  { html: '<div>First sentence.</div><div>Following paragraph.</div>', offset: 15 },
  { html: '<p><b>First sentence.</b></p><p>Following paragraph.</p>', offset: 15 },
  ...[0, 6, 15].map(offset => ({ html: 'First sentence.', offset })),
  { html: 'First sentence.', offset: 0, all: true },
  { html: 'First sentence.<img alt="Cover">', offset: 0, all: true },
  { html: '<img alt="Cover"><p>First sentence.</p>', offset: 0, all: true }
]

for (const shared of [false, true]) for (const pages of [false, true])
test(`Enter preserves scene ownership, line breaks and undo, shared=${shared}, pages=${pages}`, async () => {
  const h = await launchApp('nl-writing-enter-')
  try {
    const book = await seedBook(h, { Chapter: cases.map((_, i) => `Scene ${i}`) }, 'Paragraph input', false)
    const chapter = book.chapters[0]
    for (const [index, scene] of chapter.scenes.entries()) {
      await h.rpc('scenes/write', [chapter.guid, scene.id, cases[index].html, ''])
    }
    if (shared) await h.rpc('collaboration/peer/host', ['127.0.0.1', 0, 'Writer'])
    await dismissTour(h.page)
    await enterWriting(h.page)
    for (const [index, scene] of chapter.scenes.entries()) {
      const source = cases[index]
      const prefix = source.all ? '' : 'First sentence.'.slice(0, source.offset)
      const suffix = source.all ? '' : 'First sentence.'.slice(source.offset)
      await h.page.evaluate(async ({ chapter, scene, pages }) => {
        await window.novalistStores.settings.getState().update('global', { pageViewEnabled: pages, enableBookWidth: true })
        await window.novalistStores.project.getState().openScene(chapter, scene)
      }, { chapter: chapter.guid, scene: scene.id, pages })
      await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
      const frame = h.page.frames().find(frame => frame.url().includes('/editor/editor.html'))!
      const root = frame.locator(`[data-writing-scene="${scene.id}"]`)
      const paragraphText = () => frame.evaluate(() => {
        const selection = window.getSelection()!
        const element = selection.focusNode!.nodeType === Node.ELEMENT_NODE ? selection.focusNode as Element : selection.focusNode!.parentElement!
        return (element.closest('p, div:not(.nv-page)') as HTMLElement)?.innerText
      })
      await expect(root).toContainText('First sentence.')
      await root.click()
      await frame.evaluate(({ id, offset, all }) => {
        const editor = window as unknown as EditorWindow
        const scene = editor.getWritingSceneRoot(id)!
        if (all) { window.getSelection()!.selectAllChildren(scene); return }
        const text = document.createTreeWalker(scene, NodeFilter.SHOW_TEXT).nextNode()!
        window.getSelection()!.setBaseAndExtent(text, offset, text, offset)
      }, { id: scene.id, offset: source.offset, all: source.all })
      await h.page.keyboard.press('Enter')
      await h.page.waitForTimeout(500)
      await expect.poll(paragraphText).toBe(suffix || '\n')
      if (source.all) await expect(root.locator('img')).toHaveCount(0)
      const read = () => frame.evaluate(id => (window as unknown as EditorWindow).serializeWritingScene(id), scene.id)
      const split = await read()
      await h.page.keyboard.press('ControlOrMeta+z')
      await expect.poll(read).toBe(source.html)
      await h.page.keyboard.press('ControlOrMeta+Shift+z')
      await expect.poll(read).toBe(split)
      await h.page.keyboard.type('New paragraph.', { delay: 20 })
      await expect(root).toHaveCount(1)
      await expect(root).toHaveText(prefix + 'New paragraph.' + suffix + (source.html.includes('Following paragraph.') ? 'Following paragraph.' : ''))
      await expect.poll(paragraphText).toBe('New paragraph.' + suffix)
      await h.page.keyboard.press('Shift+Enter')
      await h.page.waitForTimeout(300)
      await h.page.keyboard.type('Next line.', { delay: 20 })
      await expect.poll(paragraphText).toBe('New paragraph.\nNext line.' + suffix)
    }
  } finally { await h.close() }
})
