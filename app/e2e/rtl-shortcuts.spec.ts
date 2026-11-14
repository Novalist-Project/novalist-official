import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildRtlContent } from './fixtures/rtlContent'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

async function arabicShortcut(page: Page, code: string, key: string, shift = false): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const windowsVirtualKeyCode = code.startsWith('Key') ? code.charCodeAt(3) : 0
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers: 2 | (shift ? 8 : 0) })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers: 2 | (shift ? 8 : 0) })
  await cdp.detach()
}

test('trusted Arabic keys reserve native clipboard, forward app commands and request history', async ({ page }) => {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setWritingContext({ workspaceId: 'keys', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'keys')
    editor.setWritingProjection([{ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId: 's', html: '<p>مرحبا English</p>', hash: '', revision: 0 }], null)
    const probe = { messages: [] as {type:string;code?:string;direction?:string}[], copied: false, cut: false, pasted: false, trusted: true }
    Object.assign(window, { shortcutProbe: probe, sendMessage: (message: {type:string;code?:string;direction?:string}) => probe.messages.push(message) })
    document.querySelector('#editor')!.addEventListener('copy', () => { probe.copied = true })
    document.querySelector('#editor')!.addEventListener('cut', () => { probe.cut = true })
    document.querySelector('#editor')!.addEventListener('paste', () => { probe.pasted = true })
    document.querySelector('#editor')!.addEventListener('keydown', event => { probe.trusted &&= event.isTrusted })
    editor.focusEditor()
  })
  await arabicShortcut(page, 'KeyA', 'ش')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('مرحبا English')
  await arabicShortcut(page, 'KeyC', 'ؤ')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowRight')
  await arabicShortcut(page, 'KeyX', 'ء')
  await arabicShortcut(page, 'KeyV', 'ر')
  await expect(page.locator('[data-writing-scene]')).toContainText('مرحبا English')
  await arabicShortcut(page, 'KeyS', 'س')
  await arabicShortcut(page, 'KeyF', 'ب')
  await arabicShortcut(page, 'KeyB', 'لا')
  await arabicShortcut(page, 'KeyZ', 'ئ')
  await arabicShortcut(page, 'KeyZ', 'ئ', true)
  const result = await page.evaluate(() => (window as unknown as {shortcutProbe: {messages:{type:string;code?:string;direction?:string}[];copied:boolean;cut:boolean;pasted:boolean;trusted:boolean}}).shortcutProbe)
  expect(result.copied).toBe(true)
  expect(result.cut).toBe(true)
  expect(result.pasted).toBe(true)
  expect(result.trusted).toBe(true)
  expect(result.messages.filter(message => message.type === 'hotkey').map(message => message.code), JSON.stringify(result)).toEqual(['KeyS','KeyF','KeyB'])
  expect(result.messages.filter(message => message.type === 'writingHistoryRequested').map(message => message.direction)).toEqual(['undo','redo'])
})

test('trusted Arabic Markdown formatting and history invoke registered commands', async ({ page }) => {
  await page.goto(await buildRtlContent())
  const editor = page.getByRole('textbox', { name: 'Mixed Markdown' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Shift+Home')
  await arabicShortcut(page, 'KeyB', 'لا')
  await expect(editor).toContainText('**مرحبا بالعالم')
  await arabicShortcut(page, 'KeyZ', 'ئ')
  await expect(editor).not.toContainText('**')
  await arabicShortcut(page, 'KeyY', 'غ')
  await expect(editor).toContainText('**مرحبا بالعالم')
})

test('trusted full-scene cut and paste retains scene ownership and serialized content', async ({ page }) => {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setWritingContext({ workspaceId: 'clipboard', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'clipboard')
    editor.setWritingProjection([{ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId: 's', html: '<p>مرحبا English</p>', hash: '', revision: 0 }], null)
    editor.focusEditor()
  })
  await arabicShortcut(page, 'KeyA', 'ش')
  await arabicShortcut(page, 'KeyX', 'ء')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())).toHaveLength(1)
  await arabicShortcut(page, 'KeyV', 'ر')
  await expect(page.locator('[data-writing-scene]')).toHaveText('مرحبا English')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())).toHaveLength(1)
  const saved = await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('s'))
  expect(saved).toContain('مرحبا English')
  await expect(page.locator('#editor > p')).toHaveCount(0)
  await page.reload()
  await page.evaluate(html => {
    const editor = window as unknown as EditorWindow
    editor.setWritingContext({ workspaceId: 'clipboard', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'clipboard')
    editor.setWritingProjection([{ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId: 's', html, hash: '', revision: 0 }], null)
  }, saved)
  await expect(page.locator('[data-writing-scene]')).toHaveText('مرحبا English')
})
