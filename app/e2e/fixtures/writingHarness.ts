import { _electron, chromium, type Browser, type ElectronApplication, type Page, type Frame } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import requireDesktopPermission from '../desktopSetup'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import type { FixtureBook } from './writingBook'
import { build } from 'esbuild'
import './writingContract'
import { closeTestApp } from '../harness'
import { scopeEditorSource } from './writingEngineSource'

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
  let profile: string | undefined
  let page: Page
  const optimized = process.env.NOVALIST_WRITING_OPTIMIZE !== '0'
  const scoped = mode === 'experiment' && optimized && process.env.NOVALIST_WRITING_SCOPED !== '0'
  const close = async (): Promise<void> => {
    try {
      if (electron) await closeTestApp(electron)
      if (browser) await browser.close()
    } finally {
      if (profile) {
        if (dirname(profile) !== resolve(tmpdir()) || !basename(profile).startsWith('novalist-writing-')) throw new Error('Unexpected fixture profile location.')
        await rm(profile, { recursive: true, force: true })
      }
    }
  }
  try {
  if (process.env.NOVALIST_WRITING_ENGINE === 'electron') {
    requireDesktopPermission()
    profile = await mkdtemp(join(resolve(tmpdir()), 'novalist-writing-'))
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    env.NOVALIST_NO_CLIPBOARD = '1'
    electron = await _electron.launch({ args: [resolve('e2e/fixtures/writingElectron.cjs'), `--user-data-dir=${profile}`], env })
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
    const body = await readFile(file)
    await route.fulfill({ contentType, body: scoped && name.endsWith('.js') ? scopeEditorSource(name, body.toString('utf8')) : body })
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
        return frame.contentDocument?.readyState === 'complete' && typeof editor?.setContent === 'function'
      }).length === count, count)
      if (mode === 'experiment') await page.evaluate(({ book, optimized, scoped }) => window.installWriting(book, optimized, scoped), { book, optimized, scoped })
      else for (const [index, frame] of frames().entries()) await frame.evaluate(scene => (window as unknown as EditorWindow).setContent(scene.html), book.scenes[index % book.scenes.length])
    },
    close
  }
  } catch (error) { await close(); throw error }
}
