import { _electron, chromium, type Browser, type ElectronApplication, type Page, type Frame } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import requireDesktopPermission from '../desktopSetup'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import type { FixtureBook } from './writingBook'
import { build } from 'esbuild'
import './writingContract'

export type WritingMode = 'original' | 'experiment'
export interface WritingHarness {
  page: Page
  seed(book: FixtureBook): Promise<void>
  frames(): Frame[]
  close(): Promise<void>
}

export async function launchWriting(mode: WritingMode, paneCount = 1): Promise<WritingHarness> {
  let browser: Browser | undefined
  let electron: ElectronApplication | undefined
  let page: Page
  if (process.env.NOVALIST_WRITING_ENGINE === 'electron') {
    requireDesktopPermission()
    electron = await _electron.launch({ args: [resolve('e2e/fixtures/writingElectron.cjs')] })
    page = await electron.firstWindow()
  } else {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  }
  await page.route('http://127.0.0.1:38917/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const name = basename(pathname)
    if (name === 'harness') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="display:flex;margin:0"></body>' })
      return
    }
    const contentType = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'
    const root = resolve('src/renderer/public')
    const file = resolve(root, `.${pathname}`)
    if (!file.startsWith(root + sep)) throw new Error('Asset outside the editor fixture.')
    await route.fulfill({ contentType, body: await readFile(file) })
  })
  await page.goto('http://127.0.0.1:38917/harness')
  if (mode === 'experiment') {
    const bundle = await build({ entryPoints: [resolve('e2e/fixtures/writingExperiment.ts')], bundle: true, write: false, format: 'iife', platform: 'browser' })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
  }
  const frames = (): Frame[] => page.frames().filter(frame => frame !== page.mainFrame())
  return {
    page, frames,
    async seed(book) {
      const count = mode === 'original' ? book.scenes.length * paneCount : paneCount
      await page.evaluate(count => {
        document.body.replaceChildren()
        for (let i = 0; i < count; i++) {
          const frame = document.createElement('iframe')
          frame.src = '/editor/editor.html'
          frame.style.cssText = 'height:980px;flex:1;min-width:0;border:0'
          document.body.append(frame)
        }
      }, count)
      await page.waitForFunction(count => Array.from(document.querySelectorAll('iframe')).filter(frame => {
        const editor = frame.contentWindow as EditorWindow | null
        return typeof editor?.setContent === 'function'
      }).length === count, count)
      if (mode === 'experiment') await page.evaluate(book => window.installWriting(book), book)
      else for (const [index, frame] of frames().entries()) await frame.evaluate(scene => (window as unknown as EditorWindow).setContent(scene.html), book.scenes[index % book.scenes.length])
    },
    async close() {
      if (electron) await electron.close()
      if (browser) await browser.close()
    }
  }
}
