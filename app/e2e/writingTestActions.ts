import { expect, type Page } from '@playwright/test'

export async function replaceWritingScene(page: Page, sceneId: string, html: string): Promise<void> {
  const scene = page.locator('.editor-frame').first().contentFrame().locator(`[data-writing-scene="${sceneId}"]`)
  await expect(scene).toBeVisible()
  await scene.evaluate((element, html) => {
    const document = element.ownerDocument
    document.getElementById('editor')!.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const transfer = new DataTransfer()
    transfer.setData('text/html', html)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, html)
  await expect(scene).toBeAttached()
}

export async function flushWriting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registry = window.novalistStores.project.getState().getWritingRegistry()
    if (!registry) throw new Error('The writing owner is unavailable.')
    await registry.flush()
  })
}
