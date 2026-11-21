import { test, expect, type Locator } from '@playwright/test'
import { launchApp, seedBook } from './harness'

async function glyphHeight(editor: Locator): Promise<number> {
  return editor.evaluate(root => {
    const text = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    return range.getBoundingClientRect().height
  })
}

for (const view of ['write', 'manuscript'] as const) {
  for (const bookWidth of [false, true]) {
    test(`Ctrl+wheel zooms ${view} without changing font settings, book width=${bookWidth}`, async () => {
      const h = await launchApp('nl-writing-zoom-')
      try {
        const book = await seedBook(h, { One: ['Opening'] }, 'Zoom fixture', false)
        await h.rpc('scenes/write', [book.chapters[0].guid, book.chapters[0].scenes[0].id, '<p>A sentence to zoom.</p>', 'A sentence to zoom.'])
        await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), book.chapters[0])
        await h.page.evaluate(async (enabled) => {
          await window.novalistStores.settings.getState().load()
          await window.novalistStores.settings.getState().update('global', {
            enableBookWidth: enabled, editorFontSize: 20, bookFontSize: 17,
            pageViewEnabled: false
          })
        }, bookWidth)
        await h.page.evaluate(view => {
          const shell = window.novalistStores.shell.getState()
          shell.setPaneWritingScope(shell.activePaneId, view === 'write' ? 'scene' : 'manuscript')
        }, view)
        const frame = h.page.frameLocator('iframe[title="editor"]')
        const editor = frame.locator('[data-writing-scene]').first()
        await expect(editor).toHaveText('A sentence to zoom.')
        const zoom = await editor.evaluate(element => Number(getComputedStyle(element).getPropertyValue('--writing-zoom-scale')))
        const initial = bookWidth ? 17 : 20
        await expect(editor).toHaveCSS('font-size', `${initial * zoom}px`)
        const initialHeight = await glyphHeight(editor)
        await editor.hover()
        await h.page.keyboard.down('Control')
        await h.page.mouse.wheel(0, -100)
        await expect.poll(() => glyphHeight(editor)).toBeGreaterThan(initialHeight)
        await h.page.mouse.wheel(0, 100)
        await expect.poll(() => glyphHeight(editor)).toBe(initialHeight)
        await h.page.keyboard.up('Control')
        await h.page.mouse.wheel(0, 100)
        await expect(editor).toHaveCSS('font-size', `${initial * zoom}px`)

        const sizes = await h.page.evaluate(() => {
          const settings = window.novalistStores.settings.getState().view!.effective
          return { editor: settings.editorFontSize, book: settings.bookFontSize }
        })
        expect(sizes).toEqual({ editor: 20, book: 17 })

        const field = bookWidth ? 'bookFontSize' : 'editorFontSize'
        await h.page.evaluate(key => window.novalistStores.settings.getState().update('project', { [key]: 22 }), field)
        await expect.poll(() => editor.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(22 * zoom, 1)
        const projectHeight = await glyphHeight(editor)
        await editor.hover()
        await h.page.keyboard.down('Control')
        await h.page.mouse.wheel(0, -100)
        await expect.poll(() => glyphHeight(editor)).toBeGreaterThan(projectHeight)
        await h.page.keyboard.up('Control')
        const stored = await h.page.evaluate(key => {
          const settings = window.novalistStores.settings.getState().view!
          return { global: settings.global[key], project: settings.overrides![key] }
        }, field)
        expect(stored).toEqual({ global: initial, project: 22 })
      } finally {
        await h.close()
      }
    })
  }
}
