import { expect, test } from '@playwright/test'
import { enterWriting, launchApp, resizeWindow, seedBook } from './harness'

for (const pageView of [false, true]) {
  test(`first scene uses its presentation scale once and preserves manual zoom, page view=${pageView}`, async () => {
    const h = await launchApp('nl-initial-zoom-')
    try {
      await h.page.evaluate(enabled => window.novalistStores.settings.getState().update('global', { pageViewEnabled: enabled }), pageView)
      await seedBook(h, { One: ['Opening', 'Next scene'] }, 'Spec', false)
      await resizeWindow(h, 1500, 900)
      await h.page.evaluate(async (pages) => {
        await window.novalistStores.settings.getState().update('global', {
          enableBookWidth: !pages, bookPageFormat: 'Custom', bookTextBlockWidth: 4.2,
          pageViewEnabled: pages, editorFontSize: 17, bookFontSize: 17,
          spellCheckEnabled: false, grammarCheckEnabled: false
        })
      }, pageView)
      await enterWriting(h.page)
      await h.page.locator('.binder-scene-row').first().click()
      const frame = h.page.frameLocator('iframe[title="editor"]')
      const editor = frame.locator('#editor')
      if (pageView) await expect(frame.locator('body')).toHaveClass(/\bpage-view\b/)
      else await expect(frame.locator('body')).not.toHaveClass(/\bpage-view\b/)
      const scale = () => editor.evaluate(element => Number(getComputedStyle(element).getPropertyValue('--writing-zoom-scale')))
      await expect.poll(scale).toBeGreaterThanOrEqual(1.3)
      const presentationScale = pageView ? 1.3 : await editor.evaluate(() => {
        const fit = (window as Window & { getWritingZoomToFit?: () => number }).getWritingZoomToFit!()
        return Math.max(1.3, Math.min(3, Math.floor(fit * 100) / 100))
      })
      await expect.poll(scale).toBe(presentationScale)
      await expect.poll(() => frame.locator('[data-writing-scene]').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(17 * presentationScale, 1)
      expect(await frame.locator('#editor-wrapper').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const fitted = await scale()
      await editor.hover()
      await h.page.keyboard.down('Control')
      await h.page.mouse.wheel(0, 100)
      await h.page.keyboard.up('Control')
      await expect.poll(scale).toBeLessThan(fitted)
      const chosen = await scale()
      await h.page.locator('.binder-scene-row').nth(1).click()
      await expect.poll(scale).toBe(chosen)
      await resizeWindow(h, 1300, 900)
      await expect.poll(() => h.page.locator('iframe[title="editor"]').evaluate(element => element.clientWidth)).toBeLessThan(1200)
      await expect.poll(scale).toBe(chosen)
      await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('dashboard'))
      await expect(editor).toHaveCount(0)
      await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('write'))
      await expect.poll(scale).toBe(chosen)
    } finally {
      await h.close()
    }
  })
}
