import { test, expect, type Locator } from '@playwright/test'
import { launchApp, seedBook, resizeWindow } from './harness'

async function readLines(editor: Locator) {
  return editor.evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const lines: string[] = []
    let top = -Infinity
    let glyphHeight = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.textContent!.length; i++) {
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const rect = range.getBoundingClientRect()
        if (Math.abs(rect.top - top) > 1) {
          lines.push('')
          top = rect.top
        }
        lines[lines.length - 1] += node.textContent![i]
        glyphHeight = Math.max(glyphHeight, rect.height)
      }
    }
    return { lines, glyphHeight }
  })
}

for (const mode of ['scene', 'pages', 'manuscript'] as const) {
  for (const bookWidth of [false, true]) {
    test(`${mode} zoom reflows prose inside a stable column with book width=${bookWidth}`, async () => {
      const h = await launchApp('nl-zoom-layout-')
      try {
        await h.page.evaluate(enabled => window.novalistStores.settings.getState().update('global', { pageViewEnabled: enabled }), mode === 'pages')
        const book = await seedBook(h, { One: ['Opening'] }, 'Zoom layout fixture', false)
        const prose = 'A long paragraph with varied words makes changes in line wrapping visible. '.repeat(12)
        await h.rpc('scenes/write', [book.chapters[0].guid, book.chapters[0].scenes[0].id, `<p>${prose}</p>`, prose])
        await resizeWindow(h, 1500, 900)
        await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), book.chapters[0])
        await h.page.evaluate(async ({ bookWidth, mode }) => {
          await window.novalistStores.settings.getState().update('global', {
            enableBookWidth: bookWidth, bookPageFormat: 'Custom', bookTextBlockWidth: 4.63,
            editorFontSize: 17, bookFontSize: 17, editorFontFamily: 'Georgia', bookFontFamily: 'Georgia',
            pageViewEnabled: mode === 'pages', spellCheckEnabled: false, grammarCheckEnabled: false
          })
          const shell = window.novalistStores.shell.getState()
          shell.setPaneWritingScope(shell.activePaneId, mode === 'manuscript' ? 'manuscript' : 'scene')
        }, { bookWidth, mode })
        const frame = h.page.frameLocator('iframe[title="editor"]')
        const editor = frame.locator('[data-writing-scene]').first()
        if (mode === 'pages') await expect(frame.locator('body')).toHaveClass(/\bpage-view\b/)
        else await expect(frame.locator('body')).not.toHaveClass(/\bpage-view\b/)
        await expect(editor).toHaveText(prose)
        if (mode === 'pages') await expect(frame.locator('.nv-page')).toBeVisible()
        // Startup now fits the first scene. Establish 100% through the real
        // gesture before checking exact doubling/halving and zoom limits.
        await editor.hover()
        await h.page.keyboard.down('Control')
        for (let step = 0; step < 25; step++) await h.page.mouse.wheel(0, 100)
        for (let step = 0; step < 5; step++) await h.page.mouse.wheel(0, -100)
        await h.page.keyboard.up('Control')
        await expect.poll(() => editor.evaluate(element => Number(getComputedStyle(element).getPropertyValue('--writing-zoom-scale')))).toBe(1)
        const before = await readLines(editor)
        expect(before.lines.length).toBeGreaterThan(3)
        await editor.hover()
        await h.page.keyboard.down('Control')
        await h.page.mouse.wheel(0, -100)
        await expect.poll(async () => (await readLines(editor)).glyphHeight).toBeGreaterThan(before.glyphHeight)
        await expect.poll(async () => (await readLines(editor)).lines.length).toBeGreaterThanOrEqual(before.lines.length)
        for (let step = 0; step < 9; step++) await h.page.mouse.wheel(0, -100)
        await expect.poll(async () => (await readLines(editor)).glyphHeight).toBeGreaterThan(before.glyphHeight * 1.8)
        await expect.poll(async () => (await readLines(editor)).lines.length).toBeGreaterThanOrEqual(before.lines.length)
        const scroller = frame.locator('#editor-wrapper')
        const overflow = await scroller.evaluate(el => ({ width: el.scrollWidth, visible: el.clientWidth, overflow: getComputedStyle(el).overflowX }))
        expect(overflow.width - overflow.visible).toBeLessThanOrEqual(1)
        const column = await editor.boundingBox(), viewport = await scroller.boundingBox()
        expect(column!.x).toBeGreaterThanOrEqual(viewport!.x)
        expect(column!.x + column!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width)
        expect(overflow.overflow).toBe('auto')
        for (let step = 0; step < 9; step++) await h.page.mouse.wheel(0, 100)
        await h.page.mouse.wheel(0, 100)
        await expect.poll(async () => (await readLines(editor)).glyphHeight).toBeCloseTo(before.glyphHeight, 1)
        await expect.poll(async () => (await readLines(editor)).lines).toEqual(before.lines)
        for (let step = 0; step < 5; step++) await h.page.mouse.wheel(0, 100)
        await expect.poll(async () => (await readLines(editor)).glyphHeight).toBeCloseTo(before.glyphHeight / 2, 1)
        await expect.poll(async () => (await readLines(editor)).lines.length).toBeLessThanOrEqual(before.lines.length)
        expect(await scroller.evaluate(element => element.scrollWidth)).toBe(await scroller.evaluate(element => element.clientWidth))
        await h.page.keyboard.up('Control')
      } finally {
        await h.close()
      }
    })
  }
}
