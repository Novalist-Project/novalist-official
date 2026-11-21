import { expect, test, type Locator, type Page } from '@playwright/test'
import { dismissTour, enterWriting, launchApp, seedBook } from './harness'

type Rgb = [number, number, number]

const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** A theme token resolved to the rgb the page paints it as. */
async function tokenColor(page: Page, token: string): Promise<Rgb> {
  return page.evaluate((name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    document.body.appendChild(probe)
    const [r, g, b] = getComputedStyle(probe).color.match(/[\d.]+/g)!.map(Number)
    probe.remove()
    return [r, g, b] as [number, number, number]
  }, token)
}

/** Decodes a screenshot in the page and returns its pixels, a fraction of its width in from each edge. */
async function pngPixels(page: Page, png: Buffer, insetFraction: number): Promise<Rgb[]> {
  return page.evaluate(async ({ data, fraction }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const edge = Math.ceil(bitmap.width * fraction)
    const { data: rgba, width, height } = context.getImageData(edge, edge, bitmap.width - edge * 2, bitmap.height - edge * 2)
    const pixels: [number, number, number][] = []
    for (let i = 0; i < width * height * 4; i += 4) pixels.push([rgba[i], rgba[i + 1], rgba[i + 2]])
    return pixels
  }, { data: png.toString('base64'), fraction: insetFraction })
}

/** The pixels inside a control's border, read from what is actually on screen. */
const innerPixels = async (page: Page, control: Locator): Promise<Rgb[]> =>
  pngPixels(page, await control.screenshot(), 0.2)

/**
 * Checkboxes are painted by the browser, so their palette comes from the
 * page's color-scheme rather than from any token. A light theme that left the
 * scheme dark showed every unchecked box as a dark square on light paper.
 */
test('checkboxes take their colours from every built-in theme', async () => {
  const h = await launchApp('nl-theme-checkboxes-')
  try {
    await seedBook(h, { 'Chapter One': ['A'], 'Chapter Two': ['B'] })
    await dismissTour(h.page)
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('export'))
    const boxes = h.page.locator('.export-chapters').first().getByRole('checkbox')
    await expect(boxes).toHaveCount(2, { timeout: 20_000 })
    await boxes.nth(1).uncheck()
    await expect(boxes.nth(0)).toBeChecked()
    // The pointer is still on the box it just cleared; a hovered box is drawn
    // differently, and the pixels below are meant to be the resting state.
    await h.page.mouse.move(0, 0)
    const themes = [['Default', 'dark'], ['Discord', 'discord'], ['Light', 'light'], ['High Contrast', 'high-contrast'], ['Catppuccin Mocha', 'catppuccin-mocha']]
    for (const [theme, slug] of themes) {
      await h.page.evaluate((name) => window.novalistStores.settings.getState().update('global', { theme: name }), theme)
      await expect.poll(() => h.page.evaluate(() => document.documentElement.dataset.theme)).toBe(slug)
      const surface = await tokenColor(h.page, '--nl-surface-input')
      const text = await tokenColor(h.page, '--nl-text')
      const accent = await tokenColor(h.page, '--nl-accent')
      // Polled because the shell eases colour changes on controls.
      await expect.poll(async () => {
        const unchecked = await innerPixels(h.page, boxes.nth(1))
        const mean = [0, 1, 2].map((c) => unchecked.reduce((sum, p) => sum + p[c], 0) / unchecked.length) as Rgb
        const checked = await innerPixels(h.page, boxes.nth(0))
        const accentShare = checked.filter((p) => distance(p, accent) < 60).length / checked.length
        return {
          uncheckedLooksLikeSurface: distance(mean, surface) < distance(mean, text),
          checkedFilledWithAccent: accentShare > 0.3,
          checkedShowsMark: accentShare < 0.95
        }
      }, { message: theme, timeout: 15_000 }).toEqual({ uncheckedLooksLikeSurface: true, checkedFilledWithAccent: true, checkedShowsMark: true })
    }
  } finally {
    await h.close()
  }
})

/**
 * The editor frame's page is transparent in Focus so the surround shows through,
 * and Chromium only keeps a frame's canvas transparent while the frame's colour
 * scheme matches its host's. A frame left dark under the Light theme painted an
 * opaque near-black band between the paper and the surround.
 */
test('the Focus surround shows through the editor frame in the Light theme', async () => {
  const h = await launchApp('nl-theme-frame-scheme-')
  try {
    await h.page.evaluate(() => window.novalistStores.settings.getState().update('global', { pageViewEnabled: true }))
    const book = await seedBook(h, { Chapter: ['Scene'] })
    await dismissTour(h.page)
    await h.page.evaluate(async (chapter) => {
      await window.novalistStores.settings.getState().update('global', { theme: 'Light', focusBackgroundColor: '#abcdee' })
      await window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id)
    }, book.chapters[0])
    await enterWriting(h.page)
    const frame = h.page.locator('iframe.editor-frame').first()
    const body = h.page.frameLocator('iframe.editor-frame').first().locator('body')
    const paper = body.locator('.nv-page').first()
    await expect(paper).toBeVisible({ timeout: 30_000 })
    await h.page.evaluate(() => window.novalistStores.shell.getState().toggleFocusMode())
    await expect(body).toHaveClass(/focus-appearance/)
    const surround: Rgb = [0xab, 0xcd, 0xee]
    // Polled because Focus eases in and the window may be entering full screen.
    await expect.poll(async () => {
      const frameBox = (await frame.boundingBox())!
      const paperBox = (await paper.boundingBox())!
      // The left margin contains scene controls. Sample the clear space between
      // the paper's right edge and the frame scrollbar, beside the visible page.
      const paperRight = paperBox.x + paperBox.width
      const gap = frameBox.x + frameBox.width - paperRight
      const top = Math.max(frameBox.y, paperBox.y)
      const bottom = Math.min(frameBox.y + frameBox.height, paperBox.y + paperBox.height)
      if (gap < 8 || bottom - top < 4) return Infinity
      const sample = await h.page.screenshot({ clip: {
        x: Math.floor(paperRight + gap / 2) - 2, y: Math.floor((top + bottom) / 2) - 2, width: 4, height: 4
      } })
      const pixels = await pngPixels(h.page, sample, 0)
      return Math.max(...pixels.map(pixel => distance(pixel, surround)))
    }, { message: 'The frame should show the configured Focus surround beside the paper', timeout: 15_000 }).toBeLessThan(32)
  } finally {
    await h.close()
  }
})
