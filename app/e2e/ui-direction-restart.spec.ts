import { expect, test, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = String.raw`
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import i18n from './src/renderer/src/i18n'
import { reportUiDirection } from './src/renderer/src/stores/uiDirectionStore'
import { appearanceSettingsBody } from './src/renderer/src/views/settings/appearanceSettingsBody'
const calls = { directions: [], restarts: 0, wanted: false }
window.calls = calls
if (!new URLSearchParams(location.search).has('mobile')) window.novalist = {
  isMobile: false,
  setUiDirection: async direction => { calls.directions.push(direction); return calls.wanted },
  restartForUiDirection: async () => { calls.restarts++ }
}
else window.novalist = { isMobile: true }
function Fixture() {
  const { t } = useTranslation()
  return <div className="fixture-settings">{appearanceSettingsBody({ t, scopeToggle: () => null,
    eff: { language: i18n.language, theme: 'Default' }, themes: [], scopeFor: () => 'global',
    update: async (_, patch) => { await i18n.changeLanguage(patch.language); await reportUiDirection(patch.language) },
    uiScale: 100, setUiScale() {}, resetUiScale() {}, assetDirs: null })}</div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

let url: string
test.beforeAll(async () => {
  const directory = resolve('out/ui-direction-restart')
  await mkdir(directory, { recursive: true })
  const locales = (await readdir(resolve('src/renderer/src/locales'))).filter(file => file.endsWith('.json'))
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    outfile: resolve(directory, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'locales', setup: builder => builder.onLoad({ filter: /i18n[\\/]index\.ts$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      const imports = locales.map((file, index) => `import locale${index} from '../locales/${file}';`).join('\n')
      const modules = locales.map((file, index) => `'../locales/${file}': { default: locale${index} }`).join(',')
      return { contents: imports + '\n' + source.replace(/import\.meta\.glob[\s\S]*?\n\)/, `{ ${modules} }`), loader: 'ts' }
    }) }] })
  const css = ['styles/tokens.css', 'styles/base.css', 'shell/shell.css', 'styles/desktop.css', 'views/settings/settings.css', 'styles/rtl.css']
    .map(path => `<link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src', path)).href}">`).join('')
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html data-shell="desktop"><head><meta charset="utf-8">${css}
    <style>.fixture-settings{width:520px;padding:var(--nl-space-xl)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  url = pathToFileURL(resolve(directory, 'index.html')).href
})

async function open(page: Page, query = ''): Promise<void> {
  page.on('pageerror', error => { throw error })
  await page.goto(url + query)
}

const language = (page: Page, code: string) => page.locator('#set-language').selectOption(code)
const notice = (page: Page) => page.locator('.settings-restart-notice')
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: { directions: string[]; restarts: number } }).calls)

test('the notice appears when main says the menus need a restart, and the button restarts', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { (window as unknown as { calls: { wanted: boolean } }).calls.wanted = true })
  await language(page, 'ar')
  await expect(notice(page)).toBeVisible()
  expect((await calls(page)).directions).toEqual(['rtl'])
  await page.locator('.fixture-settings').screenshot({ path: 'test-results/ui-direction-arabic.png' })
  await notice(page).getByRole('button').click()
  await expect.poll(async () => (await calls(page)).restarts).toBe(1)
})

test('the notice goes away when the writer switches back and the menus no longer disagree', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { (window as unknown as { calls: { wanted: boolean } }).calls.wanted = true })
  await language(page, 'ar')
  await expect(notice(page)).toBeVisible()
  await page.evaluate(() => { (window as unknown as { calls: { wanted: boolean } }).calls.wanted = false })
  await language(page, 'en')
  await expect(notice(page)).toHaveCount(0)
  expect((await calls(page)).directions).toEqual(['rtl', 'ltr'])
})

test('the English notice reads in English and sits directly under the language select', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { (window as unknown as { calls: { wanted: boolean } }).calls.wanted = true })
  await language(page, 'de')
  await expect(notice(page)).toBeVisible()
  await language(page, 'en')
  await expect(notice(page)).toContainText('Restart')
  await expect(page.locator('#set-language + .settings-restart-notice')).toHaveCount(1)
  await page.locator('.fixture-settings').screenshot({ path: 'test-results/ui-direction-english.png' })
})

test('where the preload API is missing the notice never renders', async ({ page }) => {
  await open(page, '?mobile')
  await language(page, 'ar')
  await expect(page.locator('.settings-restart-notice')).toHaveCount(0)
})
