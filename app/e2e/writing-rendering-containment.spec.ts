import { expect, test, type Frame } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dismissTour, enterWriting, launchApp, resizeWindow, seedBook, type Harness } from './harness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

const titles = Array.from({ length: 12 }, (_, index) => `Retained scene ${index + 1}`)
const paragraph = (index: number, line: number): string =>
  `Scene ${index + 1}, paragraph ${line + 1}: retained prose remains available for native selection and editing across the complete manuscript.`
const prose = (index: number): string => Array.from({ length: 8 }, (_, line) => `<p>${paragraph(index, line)}</p>`).join('')

async function openBook(h: Harness, overrides: Record<number, string> = {}, pages = false) {
  await h.page.evaluate(enabled => window.novalistStores.settings.getState().update('global', { pageViewEnabled: enabled }), pages)
  const book = await seedBook(h, { Containment: titles }, 'Retained rendering', false)
  const projectRoot = await h.page.evaluate(() => window.novalistStores.project.getState().projectPath!)
  await writeFile(join(projectRoot, 'rendering.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
  const chapter = book.chapters.find(value => value.title === 'Containment')!
  const scenes = chapter.scenes.map((scene, index) => ({ ...scene, html: overrides[index] ?? prose(index) }))
  for (const scene of scenes) await h.rpc('scenes/write', [chapter.guid, scene.id, scene.html, ''])
  for (const scene of scenes.filter(scene => scene.html.includes('data-comment-id="render-note"'))) {
    await h.rpc('scenes/setAnnotations', [chapter.guid, scene.id, [{
      id: 'render-note', anchorText: 'Annotated opening', text: 'A retained annotation.',
      createdAt: '2026-01-01T00:00:00Z', author: 'Fixture', resolved: false
    }], []])
  }
  for (const scene of scenes.filter(scene => scene.html.includes('data-comment-id="text-note"'))) {
    await h.rpc('scenes/setAnnotations', [chapter.guid, scene.id, [{
      id: 'text-note', anchorText: 'Comment anchor', text: 'A rich-text annotation.',
      createdAt: '2026-01-01T00:00:00Z', author: 'Fixture', resolved: false
    }], [{ id: 'text-footnote', number: 1, text: 'A rich-text footnote.' }]])
  }
  await dismissTour(h.page)
  await resizeWindow(h, 1500, 900)
  await h.page.evaluate(async pages => {
    await window.novalistStores.settings.getState().update('global', {
      pageViewEnabled: pages, typewriterScrollEnabled: false, spellCheckEnabled: false, grammarCheckEnabled: false
    })
  }, pages)
  await enterWriting(h.page)
  await h.page.evaluate(async ({ chapterGuid, sceneId }) => {
    const project = window.novalistStores.project.getState()
    await project.openScene(chapterGuid, sceneId)
    const shell = window.novalistStores.shell.getState()
    shell.setPaneWritingScope(shell.activePaneId, 'manuscript')
    shell.splitActivePane('row')
    await project.openSceneIn(window.novalistStores.shell.getState().activePaneId, chapterGuid, sceneId)
  }, { chapterGuid: chapter.guid, sceneId: scenes[0].id })
  await expect(h.page.locator('iframe[title="editor"]')).toHaveCount(2)
  const frames = h.page.frames().filter(frame => frame.url().includes('/editor/editor.html'))
  for (const frame of frames) {
    await expect(frame.locator('[data-writing-scene]')).toHaveCount(scenes.length)
    if (pages) await expect(frame.locator('body')).toHaveClass(/\bpage-view\b/)
    else await expect(frame.locator('body')).not.toHaveClass(/\bpage-view\b/)
  }
  return { chapter, scenes, frames }
}

async function isSkipped(frame: Frame, id: string): Promise<boolean> {
  return frame.evaluate(id => {
    const root = (window as unknown as EditorWindow).getWritingSceneRoot(id)!
    return !root.firstElementChild!.checkVisibility({ contentVisibilityAuto: true })
  }, id)
}

test('offscreen retained scenes skip rendering in both production panes', async () => {
  const h = await launchApp('nl-writing-containment-skip-')
  try {
    const { scenes, frames } = await openBook(h)
    for (const frame of frames) {
      const id = scenes[8].id
      await expect.poll(() => isSkipped(frame, id)).toBe(true)
      expect(await frame.evaluate(id => (window as unknown as EditorWindow).serializeWritingScene(id), id)).toBe(scenes[8].html)
      await expect(frame.locator(`[data-writing-scene="${id}"] p`)).toHaveCount(8)
    }
    await h.page.locator('[data-writing-pane]').first().locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
    await expect(frames[0].locator('[data-writing-scene]')).toHaveCount(1)
    await expect(frames[0].locator('[data-writing-scene]')).toHaveCSS('content-visibility', 'visible')
    await h.page.locator('[data-writing-pane]').first().locator('.writing-scope-segments').getByRole('button', { name: 'Manuscript', exact: true }).click()
    await expect.poll(() => isSkipped(frames[0], scenes[8].id)).toBe(true)
  } finally { await h.close() }
})

async function reveal(frame: Frame, id: string, offset = 0): Promise<void> {
  await frame.evaluate(({ id, offset }) => {
    const editor = window as unknown as EditorWindow
    editor.focusEditor()
    editor.revealWritingPoint({ sceneId: id, offset, affinity: 'after' })
  }, { id, offset })
}

async function selectedViewport(frame: Frame) {
  return frame.evaluate(() => {
    const selection = window.getSelection()!
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const viewport = document.getElementById('editor-wrapper')!.getBoundingClientRect()
    return { text: selection.toString(), top: rect.top - viewport.top, bottom: rect.bottom - viewport.top,
      left: rect.left - viewport.left, right: rect.right - viewport.left,
      height: rect.height, viewportHeight: viewport.height, viewportWidth: viewport.width }
  })
}

async function expectSelectionVisible(frame: Frame, text?: string): Promise<void> {
  await expect.poll(async () => {
    const bounds = await selectedViewport(frame)
    return bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight &&
      bounds.left >= 0 && bounds.right <= bounds.viewportWidth && (text === undefined || bounds.text === text)
  }).toBe(true)
}

for (const backward of [false, true]) {
  test(`native ${backward ? 'reverse' : 'forward'} selection copies and formats never-visited middle scenes with one undo`, async () => {
    const h = await launchApp('nl-writing-containment-selection-')
    try {
      const { scenes, frames } = await openBook(h)
      const frame = frames[0]
      const middle = scenes[6].id
      await expect.poll(() => isSkipped(frame, middle)).toBe(true)
      const edge = backward ? scenes.at(-1)! : scenes[0]
      await reveal(frame, edge.id)
      if (backward) await h.page.keyboard.press('Control+End')
      await expect.poll(() => isSkipped(frame, middle)).toBe(true)
      await h.page.keyboard.press(backward ? 'Control+Shift+Home' : 'Control+Shift+End')
      const selection = await frame.evaluate(() => (window as unknown as EditorWindow).getWritingSelection())
      expect(selection?.anchor.sceneId).toBe(edge.id)
      expect(selection?.focus.sceneId).toBe(backward ? scenes[0].id : scenes.at(-1)!.id)
      // The application's clipboard handler runs without reading or writing the system clipboard.
      const copied = await frame.evaluate(() => {
        const transfer = new DataTransfer()
        document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('copy', {
          clipboardData: transfer, bubbles: true, cancelable: true
        }))
        return { text: transfer.getData('text/plain'), html: transfer.getData('text/html') }
      })
      expect(copied.text).toBe(scenes.flatMap((_, index) => Array.from({ length: 8 }, (_, line) => paragraph(index, line))).join('\n'))
      expect(copied.html).not.toContain('data-editor-chrome')
      expect(copied.html).not.toContain('data-writing-scene')
      expect(copied.html).toBe(scenes.map(scene => scene.html).join(''))
      await h.page.keyboard.press('Control+b')
      for (const pane of frames) {
        await expect(pane.locator(`[data-writing-scene="${middle}"] b, [data-writing-scene="${middle}"] strong`)).toHaveCount(8)
      }
      await h.page.keyboard.press('Control+z')
      for (const pane of frames) {
        await expect.poll(() => pane.evaluate(ids => {
          const editor = window as unknown as EditorWindow
          return ids.map(id => editor.serializeWritingScene(id))
        }, scenes.map(scene => scene.id))).toEqual(scenes.map(scene => scene.html))
      }
    } finally { await h.close() }
  })
}

test('cold and warm distant find results reveal exact selections in both panes', async () => {
  const h = await launchApp('nl-writing-containment-find-')
  try {
    const needle = 'DistantNeedle'
    const { scenes, frames } = await openBook(h, { 9: `<p>Before ${needle} after.</p>${prose(9)}` })
    for (const [index, frame] of frames.entries()) {
      await expect.poll(() => isSkipped(frame, scenes[9].id)).toBe(true)
      for (const warm of [false, true]) {
        await reveal(frame, scenes[0].id)
        await expectSelectionVisible(frame)
        const other = frames[1 - index]
        const otherScroll = await other.locator('#editor-wrapper').evaluate(element => element.scrollTop)
        await h.page.evaluate(index => {
          const pane = document.querySelectorAll<HTMLElement>('[data-writing-pane]')[index]
          window.novalistStores.shell.getState().setActivePane(pane.dataset.writingPane!)
          window.novalistStores.shell.setState({ findReplaceOpen: true })
        }, index)
        const dialog = h.page.locator('.findreplace-card')
        await dialog.locator('input').first().fill(needle)
        await dialog.getByRole('button', { name: 'Find', exact: true }).click()
        await expect(dialog.locator('.findreplace-result')).toHaveCount(1)
        await dialog.locator('.findreplace-result').click()
        await expectSelectionVisible(frame, needle)
        expect(await other.locator('#editor-wrapper').evaluate(element => element.scrollTop), `${warm ? 'warm' : 'cold'} reveal does not scroll the peer`).toBe(otherScroll)
        await h.page.evaluate(() => window.novalistStores.shell.setState({ findReplaceOpen: false }))
        await expect(dialog).toHaveCount(0)
      }
    }
  } finally { await h.close() }
})

test('direct focus followed by a cold middle reveal survives delayed focus restoration', async () => {
  const h = await launchApp('nl-writing-containment-focus-')
  try {
    const { scenes, frames } = await openBook(h)
    for (const frame of frames) {
      await expect.poll(() => isSkipped(frame, scenes[8].id)).toBe(true)
      const result = await frame.evaluate(async id => {
        const editor = window as unknown as EditorWindow & {
          NovalistEditorState: { isFocusing: boolean }
        }
        document.getElementById('editor')!.blur()
        editor.focusEditor()
        const wasFocusing = editor.NovalistEditorState.isFocusing
        editor.revealWritingPoint({ sceneId: id, offset: 10, affinity: 'after' })
        // Observe beyond the production 100 ms focus callback, without delaying the reveal.
        await new Promise(resolve => setTimeout(resolve, 150))
        return { wasFocusing, isFocusing: editor.NovalistEditorState.isFocusing,
          selection: editor.getWritingSelection() }
      }, scenes[8].id)
      expect(result.wasFocusing).toBe(true)
      expect(result.isFocusing).toBe(false)
      expect(result.selection?.focus).toMatchObject({ sceneId: scenes[8].id, offset: 10 })
      await expectSelectionVisible(frame)
    }
  } finally { await h.close() }
})

const richText = '<h2>Heading</h2><p>First <strong>bold</strong> line.<br>After break.</p><p><br></p>' +
  '<ul><li>First item</li><li>Second item</li></ul><blockquote>Quoted text.</blockquote>' +
  '<table><tbody><tr><td>Left cell</td><td>Right cell</td></tr></tbody></table>' +
  '<p><span class="nv-comment" data-comment-id="text-note">Comment anchor</span>' +
  '<sup class="nv-fn" data-fn-id="text-footnote">1</sup> <del data-nl-change="text-deletion">Deleted words</del></p>'

test('passive skipped-scene plain text preserves visible rich-text semantics without revealing', async () => {
  const h = await launchApp('nl-writing-containment-text-')
  try {
    const { scenes, frames } = await openBook(h, { 0: richText, 8: richText })
    const frame = frames[0]
    await expect.poll(() => isSkipped(frame, scenes[8].id)).toBe(true)
    const control = await frame.evaluate(id => {
      const editor = window as unknown as EditorWindow
      window.getSelection()!.removeAllRanges()
      editor.setWritingServiceScene(id)
      const observer = new MutationObserver(() => {})
      observer.observe(editor.getWritingSceneRoot(id)!, { attributes: true })
      const text = editor.getPlainText()
      const mutations = observer.takeRecords().length
      observer.disconnect()
      return { text, mutations }
    }, scenes[0].id)
    expect(control.mutations).toBe(0)
    expect(control.text).toContain('Heading')
    expect(control.text).toContain('Left cell\tRight cell')
    expect(control.text).toContain('Comment anchor1 Deleted words')
    const result = await frame.evaluate(id => {
      const editor = window as unknown as EditorWindow
      const viewport = document.getElementById('editor-wrapper')!
      const before = viewport.scrollTop
      const root = editor.getWritingSceneRoot(id)!
      const styleBefore = root.getAttribute('style')
      editor.setWritingServiceScene(id)
      const text = editor.getPlainText()
      return { text, before, after: viewport.scrollTop, selected: window.getSelection()!.rangeCount,
        html: editor.serializeWritingScene(id), styleBefore, styleAfter: root.getAttribute('style'),
        transactions: editor.captureWritingChanges() }
    }, scenes[8].id)
    expect(result.text).toBe(control.text)
    expect(result.after).toBe(result.before)
    expect(result.selected).toBe(0)
    expect(result.html).toBe(richText)
    expect(result.styleAfter).toBe(result.styleBefore)
    expect(result.transactions).toEqual([])
    await expect.poll(() => isSkipped(frame, scenes[8].id)).toBe(true)
    expect(await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()!.isDirty)).toBe(false)
  } finally { await h.close() }
})

test('passive skipped blank paragraphs preserve their rendered line breaks', async () => {
  const h = await launchApp('nl-writing-containment-blank-')
  try {
    const html = '<p><br></p><p><br></p>'
    const { scenes, frames } = await openBook(h, { 0: html, 8: html })
    const frame = frames[0]
    await expect.poll(() => isSkipped(frame, scenes[8].id)).toBe(true)
    const result = await frame.evaluate(ids => {
      const editor = window as unknown as EditorWindow
      window.getSelection()!.removeAllRanges()
      editor.setWritingServiceScene(ids[0])
      const visible = editor.getPlainText()
      editor.setWritingServiceScene(ids[1])
      return { visible, skipped: editor.getPlainText() }
    }, [scenes[0].id, scenes[8].id])
    expect(result.visible).toContain('\n')
    expect(result.skipped).toBe(result.visible)
  } finally { await h.close() }
})

test('rich retained pages preserve image, list and annotation geometry after resize and reveal', async () => {
  const h = await launchApp('nl-writing-containment-pages-')
  try {
    const image = 'novalist-project://nl/rendering.gif'
    const html = '<p><span class="nv-comment" data-comment-id="render-note">Annotated opening</span></p>' +
      '<ul><li>First list item</li><li>Second list item</li></ul>' +
      `<p><img src="${image}" width="240" height="180"></p>` + prose(8).repeat(3)
    const { chapter, scenes, frames } = await openBook(h, { 8: html }, true)
    const frame = frames[0], id = scenes[8].id
    await expect.poll(() => isSkipped(frame, id)).toBe(true)
    for (const width of [1500, 1100]) {
      await reveal(frame, scenes[0].id)
      await resizeWindow(h, width, 900)
      await reveal(frame, id, 4)
      await expectSelectionVisible(frame)
      const root = frame.locator(`[data-writing-scene="${id}"]`)
      await expect(root.locator('.nv-page').first()).toBeVisible()
      await expect(frame.locator('#commentGutter .nv-cc-text')).toHaveValue('A retained annotation.')
      await expect.poll(() => root.evaluate(element => {
        const scene = element.getBoundingClientRect()
        return [...element.querySelectorAll<HTMLElement>('.nv-page')].every(page => {
          const rect = page.getBoundingClientRect()
          const style = getComputedStyle(page)
          return rect.left >= scene.left - 1 && rect.right <= scene.right + 1 &&
            rect.height <= parseFloat(style.minHeight) + 1
        })
      })).toBe(true)
      await expect(root.locator('li')).toHaveCount(2)
      await expect.poll(() => root.locator('img').evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true)
      const contained = await root.locator('img, li, .nv-comment').evaluateAll(elements => elements.every(element => {
        const rect = element.getBoundingClientRect()
        const scene = element.closest('[data-writing-scene]')!.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.left >= scene.left - 1 && rect.right <= scene.right + 1 &&
          rect.top >= scene.top - 1 && rect.bottom <= scene.bottom + 1
      }))
      expect(contained).toBe(true)
      expect(await frame.evaluate(id => (window as unknown as EditorWindow).serializeWritingScene(id), id)).toBe(html)
    }
    await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()!.flush())
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, id])).html).toBe(html)
  } finally { await h.close() }
})
