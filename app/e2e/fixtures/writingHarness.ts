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
import { createLayoutTelemetry } from './writingLayoutTelemetry'
import { profileWritingSource, layoutSourceNames } from './writingLayoutSource'
import { fragmentSceneMarkupSource } from './writingSceneMarkupSource'

export type WritingMode = 'original' | 'experiment'
export interface WritingHarness {
  page: Page
  seed(book: FixtureBook): Promise<void>
  frames(): Frame[]
  close(): Promise<void>
}

export async function launchWriting(mode: WritingMode, paneCount = 1, profiling = process.env.NOVALIST_WRITING_PROFILE === '1'): Promise<WritingHarness> {
  let browser: Browser | undefined
  let electron: ElectronApplication | undefined
  let profile: string | undefined
  let page: Page
  const optimized = process.env.NOVALIST_WRITING_OPTIMIZE !== '0'
  const scoped = mode === 'experiment' && optimized && process.env.NOVALIST_WRITING_SCOPED !== '0'
  const fragments = mode === 'experiment' && process.env.NOVALIST_WRITING_FRAGMENTS === '1'
  if (fragments && !scoped) throw new Error('Fragment adapter requires the scoped experiment route.')
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
  if (profiling) await page.addInitScript({ content: `globalThis.__writingLayout=window===window.top?(${createLayoutTelemetry.toString()})():window.top.__writingLayout;` })
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
    let served: string | Buffer = scoped && name.endsWith('.js') ? scopeEditorSource(name, body.toString('utf8'), fragments) : body
    if (fragments && name === 'editor.html') {
      served = body.toString('utf8')
      for (const selector of ['body.page-view .nv-page > p', 'body.dim-others #editor > .nv-page > *', 'body.dim-others #editor > .nv-page > .nv-focus-block']) {
        if (served.split(selector + ' {').length !== 2) throw new Error('The fragment paper CSS seam no longer matches its exact source.')
        served = served.replace(selector + ' {', selector + ', ' + selector.replace('.nv-page > ', '.nv-page > [data-writing-fragment] > ') + ' {')
      }
    }
    if (profiling && name.endsWith('.js')) served = profileWritingSource(name, served.toString())
    await route.fulfill({ contentType, body: served })
  })
  await page.goto('http://127.0.0.1:38917/harness')
  if (mode === 'experiment') {
    const bundle = await build({ entryPoints: [resolve('e2e/fixtures/writingExperiment.ts')], bundle: true, write: false, format: 'iife', platform: 'browser',
      plugins: [{ name: 'writing-source-seams', setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          const markup = fragments && path === resolve('src/renderer/src/collaboration/sceneMarkup.ts')
          const profileSource = profiling && layoutSourceNames.includes(basename(path))
          if (!markup && !profileSource) return undefined
          let contents = await readFile(path, 'utf8')
          if (markup) contents = fragmentSceneMarkupSource(contents)
          if (profileSource) contents = profileWritingSource(basename(path), contents)
          return { contents, loader: 'ts' }
        })
      } }] })
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
      if (mode === 'experiment') await page.evaluate(({ book, optimized, scoped, fragments }) => window.installWriting(book, optimized, scoped, fragments), { book, optimized, scoped, fragments })
      else for (const [index, frame] of frames().entries()) await frame.evaluate(scene => (window as unknown as EditorWindow).setContent(scene.html), book.scenes[index % book.scenes.length])
    },
    close
  }
  } catch (error) { await close(); throw error }
}
