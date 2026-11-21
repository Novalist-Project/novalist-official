import { test, expect } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dismissTour, launchApp, seedBook } from './harness'

/**
 * An extension panel is laid out for the language its own strings are in.
 *
 * A panel is an iframe, and neither `dir` nor `lang` crosses a document
 * boundary. So in the Arabic interface every extension panel stayed
 * left-to-right unless its author had built a direction channel of their own,
 * which one extension had and the others had not.
 *
 * The rule has two halves and this asserts both through a real extension, from
 * the locale files the backend reads to the attributes on the panel's root:
 * an extension that ships the interface language is mirrored with it, and one
 * that does not keeps the direction of the English it falls back to, because
 * English text in a mirrored layout is worse than a panel left as written.
 */
test('an extension panel follows the interface direction only in a language it ships', async () => {
  test.setTimeout(120_000)

  const settings = mkdtempSync(join(tmpdir(), 'nl-panel-language-'))
  const extension = join(settings, 'Extensions', 'test.throwing')
  const locales = join(extension, 'Locales')
  mkdirSync(join(extension, 'web'), { recursive: true })
  mkdirSync(locales, { recursive: true })
  copyFileSync(resolve('../tests/Novalist.TestExtension/bin/Debug/net10.0/Novalist.TestExtension.dll'),
    join(extension, 'Novalist.TestExtension.dll'))
  writeFileSync(join(extension, 'extension.json'), JSON.stringify({
    id: 'test.throwing',
    name: 'Panel language',
    version: '1.0.0',
    entryAssembly: 'Novalist.TestExtension.dll',
    contributes: {
      views: [{
        key: 'test.panel',
        title: 'panel.title',
        iconPath: 'M4 4h16v16H4z',
        placement: 'main',
        mode: 'world',
        entry: 'web/panel.html'
      }]
    }
  }))
  writeFileSync(join(locales, 'en.json'), JSON.stringify({ panel: { title: 'Test panel' } }))
  // A panel written the way the extension guide says to write one: include the
  // shim, then use logical properties and never set a direction yourself.
  writeFileSync(
    join(extension, 'web', 'panel.html'),
    `<!doctype html><meta charset="utf-8">
     <script src="__novalist/theme.js"></script>
     <style>#mark { margin-inline-start: 40px; width: 20px; height: 20px; }</style>
     <body><div id="mark"></div></body>`
  )

  const h = await launchApp('nl-panel-language-ui-', {
    NOVALIST_SETTINGS_DIR: settings,
    NOVALIST_BACKEND_PATH: resolve('../Novalist.Backend/bin/Debug/net10.0/Novalist.Backend' + (process.platform === 'win32' ? '.exe' : ''))
  })
  try {
    const { page } = h
    const setLanguage = (language: string): Promise<void> =>
      page.evaluate((code) => window.novalistStores.settings.getState().update('global', { language: code }), language)
    const view = (): Promise<{ title: string; language: string } | undefined> =>
      page.evaluate(() => {
        const found = window.novalistStores.extensions.getState().views.find((v) => v.key === 'test.panel')
        return found && { title: found.title, language: found.language }
      })

    await setLanguage('en')
    await seedBook(h, { One: ['A'] }, 'Spec', false)
    await dismissTour(page)
    await page.evaluate(async () => {
      await window.novalistStores.extensions.getState().load()
      window.novalistStores.shell.getState().setExtView({ extensionId: 'test.throwing', key: 'test.panel' })
    })
    expect(await view()).toEqual({ title: 'Test panel', language: 'en' })

    const root = page.frameLocator('iframe[src^="novalist-ext://test.throwing/"]').locator('html')
    // Which half of the panel an element with only a logical margin sits in:
    // the attributes could be right while the layout ignored them.
    const side = (): Promise<string> =>
      root.locator('#mark').evaluate((mark) => {
        const box = mark.getBoundingClientRect()
        return box.left + box.width / 2 < window.innerWidth / 2 ? 'left' : 'right'
      })

    // "Nothing changed" has no state to wait for. The store holds the refreshed
    // views by the time the settings update resolves, so give React a frame to
    // hand them to the panel and the panel a frame to take the message; a
    // panel that was going to be mirrored wrongly is mirrored by then.
    const settle = async (): Promise<void> => {
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      await root.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    }

    await expect(root).toHaveAttribute('data-novalist-theme', 'ready', { timeout: 15_000 })
    await expect(root).toHaveAttribute('lang', 'en')
    await expect(root).toHaveAttribute('dir', 'ltr')
    expect(await side()).toBe('left')

    // Arabic interface, extension not translated: the shell mirrors, the panel
    // keeps the direction of the English it is still showing.
    await setLanguage('ar')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    expect(await view()).toEqual({ title: 'Test panel', language: 'en' })
    await settle()
    await expect(root).toHaveAttribute('lang', 'en')
    await expect(root).toHaveAttribute('dir', 'ltr')
    expect(await side()).toBe('left')

    // The extension gains an Arabic translation. Locale files are read when the
    // language changes, so leaving and re-entering Arabic picks it up.
    await setLanguage('en')
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    writeFileSync(join(locales, 'ar.json'), JSON.stringify({ panel: { title: 'لوحة الاختبار' } }))
    await setLanguage('ar')
    await expect.poll(view).toEqual({ title: 'لوحة الاختبار', language: 'ar' })
    await expect(root).toHaveAttribute('lang', 'ar', { timeout: 15_000 })
    await expect(root).toHaveAttribute('dir', 'rtl')
    await expect.poll(side).toBe('right')

    // And back: a panel left mirrored after the writer chose English again
    // would stay that way for the rest of the session.
    await setLanguage('en')
    await expect(root).toHaveAttribute('lang', 'en', { timeout: 15_000 })
    await expect(root).toHaveAttribute('dir', 'ltr')
    await expect.poll(side).toBe('left')
  } finally {
    await h.close()
  }
})
