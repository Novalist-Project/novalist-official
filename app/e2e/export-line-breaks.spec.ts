import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dismissTour, launchApp, seedBook } from './harness'
import { readZip } from './zip'

/**
 * Enter starts a new paragraph and Shift+Enter a new line inside the same one.
 * Typed in the real editor and read back out of the exported files, because
 * what the editor stores for Shift+Enter is the browser's choice, not ours.
 * Its prose is set pre-wrap, so the browser stores a newline in the text where
 * it would otherwise store a br, and an exporter that only knew the br kept
 * every line break it was tested with and none that a writer typed.
 */
test('a line typed with Shift+Enter stays a line of its paragraph in the exported book', async () => {
  test.setTimeout(180_000)
  const h = await launchApp('nl-export-linebreak-')
  try {
    const book = await seedBook(h, { Chapter: ['Scene'] })
    const chapter = book.chapters[0]
    const scene = chapter.scenes[0]
    await dismissTour(h.page)
    await h.page.evaluate(
      ({ chapter, scene }) => window.novalistStores.project.getState().openScene(chapter, scene),
      { chapter: chapter.guid, scene: scene.id }
    )
    await expect.poll(() => h.page.frames().some((f) => f.url().includes('/editor/editor.html'))).toBe(true)
    const frame = h.page.frames().find((f) => f.url().includes('/editor/editor.html'))!
    const root = frame.locator(`[data-writing-scene="${scene.id}"]`)
    await root.click()
    await h.page.keyboard.type('Erste Zeile', { delay: 20 })
    await h.page.keyboard.press('Shift+Enter')
    await h.page.keyboard.type('zweite Zeile', { delay: 20 })
    await h.page.keyboard.press('Enter')
    await h.page.keyboard.type('Neuer Absatz', { delay: 20 })
    await expect(root.locator('p')).toHaveCount(2)

    const run = (format: string, file: string): Promise<unknown> =>
      h.rpc('export/run', [format, join(h.workDir, file), 'Roman', 'A Writer', false, [chapter.guid]])
    const epubChapter = async (): Promise<string> => {
      await run('Epub', 'book.epub')
      return readZip(join(h.workDir, 'book.epub')).get('OEBPS/chapter-1.xhtml')!.toString('utf8')
    }
    // Polled until the editor's own save has reached the file the export reads.
    await expect.poll(epubChapter, { timeout: 30_000 }).toContain('Neuer Absatz')
    const xhtml = await epubChapter()
    expect(xhtml).toMatch(/<p[^>]*>Erste Zeile<br\/>zweite Zeile<\/p>/)
    expect(xhtml).toMatch(/<p[^>]*>Neuer Absatz<\/p>/)

    await run('Docx', 'book.docx')
    const word = readZip(join(h.workDir, 'book.docx')).get('word/document.xml')!.toString('utf8')
    expect(word).toMatch(/Erste Zeile<\/w:t><\/w:r><w:r><w:br\/><\/w:r><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>zweite Zeile/)

    await run('Markdown', 'book.md')
    const markdown = readFileSync(join(h.workDir, 'book.md'), 'utf8').replace(/\r\n/g, '\n')
    expect(markdown).toContain('Erste Zeile\\\nzweite Zeile\n\nNeuer Absatz')
  } finally {
    await h.close()
  }
})
