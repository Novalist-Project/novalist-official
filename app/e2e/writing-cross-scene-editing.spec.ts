import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import type { SceneSnapshot } from '../src/renderer/src/views/editor/writingTypes'

const scenes: SceneSnapshot[] = ['First scene.', 'Second scene.', 'Third scene.'].map((text, index) => ({
  bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: `s${index + 1}`,
  html: `<p>${text}</p>`, hash: '', revision: 0
}))

test.beforeEach(async ({ page }) => {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(snapshots => {
    const editor = window as unknown as EditorWindow
    editor.setWritingContext({ workspaceId: 'fixture', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }, 'fixture')
    editor.setWritingProjection(snapshots, null)
    editor.focusEditor()
  }, scenes)
})

test('native selection formatting and deletion retain separate scene wrappers', async ({ page }) => {
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.restoreWritingSelection({ anchor: { sceneId: 's2', offset: 6, affinity: 'after' }, focus: { sceneId: 's1', offset: 6, affinity: 'after' } })
    editor.toggleBold()
  })
  await expect(page.locator('[data-writing-scene="s1"] b')).toHaveText('scene.')
  await expect(page.locator('[data-writing-scene="s2"] b')).toHaveText('Second')
  await page.keyboard.press('Backspace')
  await expect(page.locator('[data-writing-scene]')).toHaveCount(3)
  const changes = await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())
  expect([...new Set(changes.flatMap(tx => tx.changes.map(change => change.ref.sceneId)))]).toEqual(['s1', 's2'])
  expect(changes.flatMap(tx => tx.changes).every(change => !change.afterHtml.includes('data-writing-scene'))).toBe(true)
})

test('copy excludes chapter chrome and boundary deletion cannot merge scenes', async ({ page }) => {
  const result = await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    const chrome = document.createElement('div')
    chrome.dataset.editorChrome = 'chapter'; chrome.textContent = 'CHAPTER LABEL'; chrome.contentEditable = 'false'
    editor.getWritingSceneRoot('s2')!.before(chrome)
    editor.restoreWritingSelection({ anchor: { sceneId: 's1', offset: 6, affinity: 'after' }, focus: { sceneId: 's2', offset: 6, affinity: 'after' } })
    const transfer = new DataTransfer()
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }))
    const point = { sceneId: 's2', offset: 0, affinity: 'after' as const }
    editor.restoreWritingSelection({ anchor: point, focus: point })
    return { text: transfer.getData('text/plain'), html: transfer.getData('text/html') }
  })
  expect(result.text).toBe('scene.\nSecond')
  expect(result.html).not.toContain('CHAPTER LABEL')
  await page.keyboard.press('Backspace')
  await expect(page.locator('[data-writing-scene]')).toHaveCount(3)
  await expect(page.locator('[data-writing-scene="s1"]')).toHaveText('First scene.')
})

test('cross-scene paste retains boundaries and sanitizes external HTML', async ({ page }) => {
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.restoreWritingSelection({ anchor: { sceneId: 's1', offset: 6, affinity: 'after' }, focus: { sceneId: 's2', offset: 6, affinity: 'after' } })
    const transfer = new DataTransfer()
    transfer.setData('text/html', '<p><strong>Paste</strong><img src=x onerror="alert(1)"></p>')
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('[data-writing-scene]')).toHaveCount(3)
  await expect(page.locator('[data-writing-scene="s1"]')).toContainText('Paste')
  await expect(page.locator('#editor [onerror]')).toHaveCount(0)
})

for (const format of ['text/plain', 'text/html']) {
  test(`pasted ${format} paragraphs accept independent heading styles`, async ({ page }) => {
    await page.evaluate(format => {
      const editor = window as unknown as EditorWindow
      const point = { sceneId: 's1', offset: 0, affinity: 'after' as const }
      editor.restoreWritingSelection({ anchor: point, focus: { ...point, offset: 12 } })
      const transfer = new DataTransfer()
      transfer.setData(format, format === 'text/plain' ? 'First\r\nSecond\r\nThird' :
        '<div><div>First<br>continued</div><div><b>Second</b></div><div>Third</div></div>')
      document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, format)
    const blocks = page.locator('[data-writing-scene="s1"] > p')
    await expect(blocks).toHaveCount(3)
    await blocks.nth(1).evaluate(block => {
      const editor = window as unknown as EditorWindow
      window.getSelection()!.collapse(block, 0)
      editor.setParagraphStyle('heading')
    })
    await expect(page.locator('.nv-style-heading')).toHaveText('Second')
    if (format === 'text/html') {
      await expect(blocks.first().locator('br')).toHaveCount(1)
      await expect(blocks.nth(1).locator('b')).toHaveText('Second')
    }
  })
}

for (const prose of ['First word', 'مرحبا عالم']) {
  test(`word deletion works in both directions and stops at scene boundaries for ${prose}`, async ({ page }) => {
    await page.evaluate(({ snapshots, prose }) => {
      const editor = window as unknown as EditorWindow
      editor.updateWritingScene({ ...snapshots[1], html: `<p>${prose}</p>`, revision: 1 })
      const point = { sceneId: 's2', offset: 0, affinity: 'after' as const }
      editor.restoreWritingSelection({ anchor: point, focus: point })
    }, { snapshots: scenes, prose })
    const scene = page.locator('[data-writing-scene="s2"]')
    await page.keyboard.press('Control+Backspace')
    await expect(scene).toHaveText(prose)
    await page.keyboard.press('Control+Delete')
    await expect(scene).toHaveText(prose.split(' ')[1])
    await scene.locator('p').evaluate(p => window.getSelection()!.collapse(p, p.childNodes.length))
    await page.keyboard.press('Control+Delete')
    await expect(scene).toHaveText(prose.split(' ')[1])
    await page.keyboard.press('Control+Backspace')
    await expect(scene).toHaveText('')
    await expect(page.locator('[data-writing-scene="s1"]')).toHaveText('First scene.')
    await expect(page.locator('[data-writing-scene="s3"]')).toHaveText('Third scene.')
  })
}

test('pasting into a paragraph preserves line breaks and the text on both sides of the caret', async ({ page }) => {
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    const point = { sceneId: 's1', offset: 6, affinity: 'after' as const }
    editor.restoreWritingSelection({ anchor: point, focus: point })
    const transfer = new DataTransfer()
    transfer.setData('text/html', '<p>First line<br>Second line</p><p>Last line<br>End </p>')
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  const paragraphs = page.locator('[data-writing-scene="s1"] > p')
  await expect(paragraphs).toHaveCount(2)
  await expect(paragraphs.first().locator('br')).toHaveCount(1)
  await expect(paragraphs.last().locator('br')).toHaveCount(1)
  await page.keyboard.type('X')
  await expect(paragraphs.last()).toContainText('End Xscene.')
})

test('page view and typewriter keep scene serialization and reverse selection', async ({ page }) => {
  const result = await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    const selection = { anchor: { sceneId: 's2', offset: 4, affinity: 'after' as const }, focus: { sceneId: 's1', offset: 2, affinity: 'after' as const } }
    editor.restoreWritingSelection(selection)
    editor.setPageView(true)
    return { html: editor.serializeWritingScene('s1'), selection: editor.getWritingSelection(), pages: document.querySelectorAll('[data-writing-scene] .nv-page').length }
  })
  expect(result.html).toBe(scenes[0].html)
  expect(result.selection?.anchor.sceneId).toBe('s2')
  expect(result.pages).toBeGreaterThan(0)
})

test('duplicate annotation IDs stay scoped to the caret scene', async ({ page }) => {
  const result = await page.evaluate(snapshots => {
    const editor = window as unknown as EditorWindow
    editor.setWritingProjection(snapshots.map(scene => ({ ...scene, html: '<p><span class="nv-comment" data-comment-id="same">Comment</span><sup class="nv-fn" data-fn-id="same">1</sup></p>' })), null)
    const point = { sceneId: 's2', offset: 2, affinity: 'after' as const }
    editor.restoreWritingSelection({ anchor: point, focus: point })
    editor.removeCommentById('same')
    editor.removeFootnoteById('same')
    return snapshots.map(scene => editor.serializeWritingScene(scene.sceneId))
  }, scenes)
  expect(result[0]).toContain('data-comment-id="same"')
  expect(result[0]).toContain('data-fn-id="same"')
  expect(result[1]).not.toContain('data-comment-id')
  expect(result[1]).not.toContain('data-fn-id')
  expect(result[2]).toContain('data-fn-id="same"')
})
