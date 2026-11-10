import { test, expect } from '@playwright/test'
import { launchApp, seedBook, resizeWindow } from './harness'

for (const view of ['manuscript', 'write'] as const) {
  test(`${view} honors book text width and the configured book font`, async () => {
    const h = await launchApp('nl-manuscript-width-')
    try {
      await seedBook(h, { One: ['Opening'] })
      await resizeWindow(h, 1800, 900)
      await h.page.locator('.binder-scene-row').first().click()
      await h.page.evaluate(async () => {
        await window.novalistStores.settings.getState().load()
        await window.novalistStores.settings.getState().update('global', {
          enableBookWidth: true, bookPageFormat: 'Custom', bookTextBlockWidth: 4,
          bookFontFamily: 'Georgia', bookFontSize: 17, editorFontFamily: 'Arial', editorFontSize: 20,
          pageViewEnabled: false
        })
      })
      await h.page.evaluate(view => {
        const shell = window.novalistStores.shell.getState()
        shell.setPaneWritingScope(shell.activePaneId, view === 'write' ? 'scene' : 'manuscript')
      }, view)
      const frame = h.page.frameLocator('iframe[title="editor"]')
      const wrapper = frame.locator('#editor-wrapper')
      const editor = frame.locator('[data-writing-scene]').first()
      await expect(wrapper).toBeVisible()
      await expect(editor).toHaveCSS('font-family', /Georgia/)
      // Set 100% before checking the configured writing size.
      await editor.hover()
      await h.page.keyboard.down('Control')
      for (let step = 0; step < 25; step++) await h.page.mouse.wheel(0, 100)
      for (let step = 0; step < 5; step++) await h.page.mouse.wheel(0, -100)
      await h.page.keyboard.up('Control')
      await expect.poll(() => editor.evaluate(element => Number(getComputedStyle(element).getPropertyValue('--writing-zoom-scale')))).toBe(1)
      const width = (): Promise<number> => editor.locator('p').first().evaluate(el => el.getBoundingClientRect().width)
      await expect(editor).toHaveCSS('font-size', '17px')
      await expect.poll(width).toBeCloseTo(384, 0)
      await h.page.evaluate(() => window.novalistStores.settings.getState().update('global', { bookTextBlockWidth: 6 }))
      await expect.poll(width).toBeCloseTo(576, 0)
      await h.page.evaluate(() => window.novalistStores.settings.getState().update('global', { bookPageFormat: 'A5' }))
      await expect.poll(width).toBeCloseTo(4.63 * 96, 0)
      await h.page.evaluate(() => window.novalistStores.settings.getState().update('global', { enableBookWidth: false }))
      await expect.poll(width).toBeGreaterThan(576)
      await expect(editor).toHaveCSS('font-size', '20px')
      await expect(editor).toHaveCSS('font-family', /Arial/)
      await resizeWindow(h, 800, 700)
      await expect.poll(() => wrapper.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await h.page.evaluate(() => window.novalistStores.settings.getState().update('global', { enableBookWidth: true }))
      await expect.poll(() => wrapper.evaluate(el => el.getBoundingClientRect().width <= innerWidth)).toBe(true)
    } finally {
      await h.close()
    }
  })
}
