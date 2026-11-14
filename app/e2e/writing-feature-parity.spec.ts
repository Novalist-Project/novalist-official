import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import type { SceneSnapshot, WritingSelection } from '../src/renderer/src/views/editor/writingTypes'

type ParityWindow = EditorWindow & {
  messages: { type: string; sceneId?: string; requestId?: number; plainText?: string; text?: string; precedingText?: string; selectedText?: string; alias?: string; comments?: { sceneId: string; anchorText: string }[] }[]
  invokeCSharpAction(json: string): void
  triggerInlineAction(id: string): void
  rememberImageTarget(): void
}

const scenes: SceneSnapshot[] = [
  ['a', '<p>First scene.</p>'], ['empty', '<p><br></p>'],
  ['hidden', '<p>Excluded prose.</p>'], ['b', '<p>Second scene.</p>']
].map(([sceneId, html]) => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId, html, hash: '', revision: 0 }))

async function select(page: Page, first = 'a', start = 6, last = 'b', end = 6): Promise<void> {
  await page.evaluate(({ first, start, last, end }) => {
    const editor = window as unknown as EditorWindow
    editor.restoreWritingSelection({ anchor: { sceneId: first, offset: start, affinity: 'after' }, focus: { sceneId: last, offset: end, affinity: 'after' } })
    editor.setWritingServiceScene(last)
  }, { first, start, last, end })
}

async function assertOwnership(page: Page): Promise<void> {
  await expect(page.locator('#editor > [data-writing-scene]')).toHaveCount(3)
  await expect(page.locator('[data-writing-scene] [data-writing-scene]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('hidden'))).toBe(scenes[2].html)
}

test.beforeEach(async ({ page }) => {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(snapshots => {
    const editor = window as unknown as ParityWindow
    editor.messages = []
    editor.invokeCSharpAction = json => editor.messages.push(JSON.parse(json))
    editor.setWritingContext({ workspaceId: 'parity', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }, 'parity')
    editor.setWritingProjection(snapshots, null)
    editor.setWritingProjection(snapshots.filter(scene => scene.sceneId !== 'hidden'), null)
    editor.focusEditor()
  }, scenes)
})

for (const [command, selector] of [
  ['toggleBold', 'b,strong'], ['toggleItalic', 'i,em'], ['toggleUnderline', 'u'],
  ['toggleStrikethrough', 'strike,s'], ['toggleHighlight', '.nv-highlight']
] as const) {
  test(`${command} partitions a backwards selection around an empty and hidden scene`, async ({ page }) => {
    await select(page, 'b', 6, 'a', 6)
    await page.evaluate(command => (window as unknown as EditorWindow)[command](), command)
    await assertOwnership(page)
    await expect(page.locator('[data-writing-scene="a"]').locator(selector)).toHaveText('scene.')
    await expect(page.locator('[data-writing-scene="b"]').locator(selector)).toHaveText('Second')
    expect(await page.evaluate(() => (window as unknown as EditorWindow).getWritingSelection()?.anchor.sceneId)).toBe('b')
    const changes = await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())
    expect(changes).toHaveLength(1)
    expect(changes[0].changes.map(change => change.ref.sceneId)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(changes[0].changes.every(change => !change.afterHtml.includes('data-writing-scene'))).toBe(true)
  })
}

for (const style of ['', 'heading', 'subheading', 'blockquote', 'poetry']) {
  test(`paragraph style ${style || 'body'} applies to prose in every selected scene`, async ({ page }) => {
    await select(page)
    await page.evaluate(style => {
      const editor = window as unknown as EditorWindow
      editor.setParagraphStyle('heading')
      editor.setParagraphStyle(style)
    }, style)
    await assertOwnership(page)
    const classes = await page.locator('[data-writing-scene] > p').evaluateAll(nodes => nodes.map(node => node.className))
    expect(classes).toEqual(Array(3).fill(style ? `nv-style-${style}` : ''))
  })
}

for (const [command, alignment] of [['alignLeft', 'left'], ['alignCenter', 'center'], ['alignRight', 'right'], ['alignJustify', 'justify']] as const) {
  test(`${command} aligns prose without styling scene wrappers`, async ({ page }) => {
    await select(page)
    await page.evaluate(command => {
      const editor = window as unknown as EditorWindow
      editor.alignCenter()
      editor[command]()
    }, command)
    await assertOwnership(page)
    for (const id of ['a', 'b']) await expect(page.locator(`[data-writing-scene="${id}"] p`)).toHaveCSS('text-align', alignment === 'left' ? /^(left|start)$/ : alignment)
    expect(await page.locator('[data-writing-scene]').evaluateAll(nodes => nodes.some(node => (node as HTMLElement).style.textAlign !== ''))).toBe(false)
  })
}

for (const [command, tag] of [['toggleBulletList', 'ul'], ['toggleNumberList', 'ol']] as const) {
  test(`${command} creates separate lists and retains all scene identities`, async ({ page }) => {
    await select(page)
    await page.evaluate(command => (window as unknown as EditorWindow)[command](), command)
    await assertOwnership(page)
    for (const id of ['a', 'b']) await expect(page.locator(`[data-writing-scene="${id}"] ${tag} li`)).toHaveCount(1)
    await expect(page.locator('#editor > ul, #editor > ol')).toHaveCount(0)
    await expect(page.locator('#editor[contenteditable="true"]')).toHaveCount(1)
    await expect(page.locator('[data-writing-scene][contenteditable]')).toHaveCount(0)
    await expect(page.locator('[data-writing-scene="empty"]')).toHaveText('')
  })
}

test('links and unlink preserve selected text in each scene', async ({ page }) => {
  await select(page)
  await page.evaluate(() => (window as unknown as EditorWindow).applyLink('https://example.com'))
  for (const id of ['a', 'b']) await expect(page.locator(`[data-writing-scene="${id}"] a`)).toHaveAttribute('href', 'https://example.com')
  await page.evaluate(() => (window as unknown as EditorWindow).applyLink(''))
  await expect(page.locator('#editor a')).toHaveCount(0)
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('First scene.')
  await assertOwnership(page)
})

test('cross-scene comments emit scene-qualified anchors and preserve inline formatting', async ({ page }) => {
  await select(page)
  const comments = await page.evaluate(() => {
    const editor = window as unknown as ParityWindow
    editor.toggleBold()
    editor.addCommentToSelection('shared-id')
    return editor.messages.filter(message => message.type === 'commentsAdded').at(-1)?.comments
  })
  expect(comments).toEqual([{ sceneId: 'a', commentId: 'shared-id', anchorText: 'scene.' }, { sceneId: 'b', commentId: 'shared-id', anchorText: 'Second' }])
  await assertOwnership(page)
  for (const id of ['a', 'b']) await expect(page.locator(`[data-writing-scene="${id}"] .nv-comment b`)).toHaveCount(1)
})

test('footnote data and ordering remain local when IDs repeat', async ({ page }) => {
  for (const id of ['a', 'b']) {
    await select(page, id, 3, id, 3)
    await page.evaluate(() => (window as unknown as EditorWindow).insertFootnoteAtSelection('same'))
  }
  const result = await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setFootnotesData([{ id: 'same', text: 'Second note' }])
    return { order: editor.footnoteOrder(), html: editor.serializeWritingScene('b') }
  })
  expect(result.order).toEqual(['same'])
  expect(result.html).not.toContain('title=')
  await expect(page.locator('[data-writing-scene="b"] sup')).toHaveAttribute('title', 'Second note')
  await expect(page.locator('[data-writing-scene="a"] sup')).not.toHaveAttribute('title')
  await assertOwnership(page)
})

test('suggested cross-scene deletion retains original words and source identities', async ({ page }) => {
  await select(page)
  await page.evaluate(() => (window as unknown as EditorWindow).setSuggestionMode(true, 'Writer'))
  await page.keyboard.press('Backspace')
  await expect(page.locator('[data-writing-scene="a"] del')).toHaveText('scene.')
  await expect(page.locator('[data-writing-scene="b"] del')).toHaveText('Second')
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('First scene.')
  await assertOwnership(page)
})

test('suggestion navigation resolves duplicate IDs in the caret scene', async ({ page }) => {
  await page.evaluate(snapshots => {
    const editor = window as unknown as EditorWindow
    editor.setWritingProjection(snapshots.filter(scene => scene.sceneId !== 'hidden').map(scene => ({ ...scene, html: '<p><ins data-nl-change="same">Proposed</ins></p>' })), null)
  }, scenes)
  await select(page, 'b', 2, 'b', 2)
  await page.evaluate(() => (window as unknown as EditorWindow).scrollToSuggestionById('same'))
  await expect(page.locator('[data-writing-scene="b"] .nv-change-flash')).toHaveCount(1)
  await expect(page.locator('[data-writing-scene="a"] .nv-change-flash')).toHaveCount(0)
})

test('an inline action replaces a cross-scene selection through one transaction', async ({ page }) => {
  await select(page)
  await page.evaluate(() => {
    const editor = window as unknown as ParityWindow
    editor.triggerInlineAction('rewrite')
    editor.applyInlineActionResult(JSON.stringify({ actionId: 'rewrite', text: 'replacement', disposition: 'replace' }))
  })
  await assertOwnership(page)
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('First replacement')
  await expect(page.locator('[data-writing-scene="b"]')).toHaveText(' scene.')
  const transactions = await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())
  expect(transactions).toHaveLength(1)
  expect(transactions[0].changes.map(change => change.ref.sceneId)).toEqual(['a', 'b'])
})

test('dictation rejects replaced scene ownership instead of inserting at its new root', async ({ page }) => {
  await select(page, 'a', 6, 'a', 6)
  const inserted = await page.evaluate(snapshot => {
    const editor = window as unknown as EditorWindow
    editor.captureDictationAnchor('voice')
    editor.updateWritingScene({ ...snapshot, html: '<p>Remote version.</p>', revision: 1 })
    return editor.insertDictationText('voice', 'late words', false, '', '')
  }, scenes[0])
  expect(inserted).toBe(false)
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('Remote version.')
  await assertOwnership(page)
})

test('native IME pins its scene through layout and scope changes, then publishes only committed text', async ({ page, context }) => {
  await select(page, 'a', 6, 'a', 6)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  expect(await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())).toEqual([])
  await page.evaluate(snapshots => {
    const editor = window as unknown as EditorWindow
    editor.setPageView(true)
    editor.setWritingProjection([snapshots[3]], null)
  }, scenes)
  await expect(page.locator('[data-writing-scene="a"]')).toHaveCount(1)
  await cdp.send('Input.insertText', { text: '你好' })
  await expect(page.locator('#editor > [data-writing-scene]')).toHaveCount(1)
  const changes = await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())
  expect(changes.flatMap(transaction => transaction.changes).map(change => [change.ref.sceneId, change.afterHtml])).toEqual([['a', '<p>First 你好scene.</p>']])
})

test('proofing offsets belong to the active scene and stale responses cannot mark its neighbor', async ({ page }) => {
  await select(page, 'a', 1, 'a', 1)
  await page.evaluate(() => (window as unknown as EditorWindow).setGrammarCheckEnabled(true))
  await expect.poll(() => page.evaluate(() => (window as unknown as ParityWindow).messages.filter(message => message.type === 'grammarCheckRequest').length)).toBeGreaterThan(0)
  const request = await page.evaluate(() => (window as unknown as ParityWindow).messages.filter(message => message.type === 'grammarCheckRequest').at(-1)!)
  expect(request.plainText).toBe('First scene.')
  await select(page, 'b', 1, 'b', 1)
  await page.evaluate(requestId => (window as unknown as EditorWindow).setGrammarIssues(JSON.stringify([{ offset: 0, length: 5, type: 'spelling', message: 'Unknown' }]), requestId), request.requestId)
  await expect(page.locator('#editor .grammar-issue')).toHaveCount(0)
  await page.evaluate(() => (window as unknown as EditorWindow).setGrammarIssues(JSON.stringify([{ offset: 0, length: 6, type: 'spelling', message: 'Unknown' }])))
  await expect(page.locator('[data-writing-scene="b"] .grammar-issue')).toHaveText('Second')
  await page.evaluate(() => (window as unknown as EditorWindow).setSpellingDictionary(['Second']))
  await expect(page.locator('#editor .grammar-issue')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())).toEqual([])
})

test('image insertion retains its captured paragraph when host focus removes the selection', async ({ page }) => {
  await select(page, 'b', 3, 'b', 3)
  await page.evaluate(() => {
    const editor = window as unknown as ParityWindow
    editor.setImageBase('https://example.com/book/')
    editor.rememberImageTarget()
    window.getSelection()!.removeAllRanges()
    editor.insertImageAtCaret('Images/picture.png', 'Picture')
  })
  await expect(page.locator('[data-writing-scene="b"] img')).toHaveAttribute('alt', 'Picture')
  await expect(page.locator('[data-writing-scene="a"] img')).toHaveCount(0)
  const html = await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('b'))
  expect(html).toContain('src="Images/picture.png"')
  expect(html).not.toContain('https://example.com')
  await assertOwnership(page)
})

test('presentation changes preserve reverse selection and produce no prose transactions', async ({ page }) => {
  await select(page, 'b', 6, 'a', 6)
  const selection = await page.evaluate(() => (window as unknown as EditorWindow).getWritingSelection()) as WritingSelection
  const result = await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setFont('serif', 18)
    editor.setBookWidth(true, 640)
    editor.setWritingZoom(1.1)
    editor.setReadingComfort(1.6, 0.2, 0.6, 1)
    editor.setBookParagraphSpacing(true)
    editor.setLanguage('de-DE')
    editor.setSpellCheck(false)
    editor.setComposeDimming(true)
    editor.setTypewriterScroll(true, 'center')
    editor.setPageView(true)
    editor.repaginatePageView()
    return { selection: editor.getWritingSelection(), changes: editor.captureWritingChanges(), fit: editor.getWritingZoomToFit() }
  })
  expect(result.selection).toEqual(selection)
  expect(result.changes).toEqual([])
  expect(result.fit).toBeGreaterThan(0)
  await assertOwnership(page)
})

test('native external drop sanitizes HTML and inserts only into its destination scene', async ({ page, context }) => {
  const box = await page.locator('[data-writing-scene="b"] p').boundingBox()
  expect(box).not.toBeNull()
  const cdp = await context.newCDPSession(page)
  const data = { items: [{ mimeType: 'text/html', data: '<section data-writing-scene="forged"><p class="nv-style-poetry"><b>Dropped</b><a href="https://example.com">Link</a><img src="Images/x.png" alt="Cover" onerror="window.badDrop=true"></p><ul><li>Item</li></ul></section>' }], dragOperationsMask: 1 }
  const position = { x: box!.x + 2, y: box!.y + box!.height / 2 }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...position, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...position, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...position, data })
  await assertOwnership(page)
  await expect(page.locator('[data-writing-scene="b"]')).toContainText('Dropped')
  expect(await page.locator('[data-writing-scene="b"]').evaluate(root => root.textContent!.split('Dropped').length - 1)).toBe(1)
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('First scene.')
  await expect(page.locator('#editor [onerror], [data-writing-scene="forged"]')).toHaveCount(0)
  await expect(page.locator('[data-writing-scene="b"] .nv-style-poetry')).toHaveCount(1)
  await expect(page.locator('[data-writing-scene="b"] a')).toHaveAttribute('href', 'https://example.com')
  await expect(page.locator('[data-writing-scene="b"] img')).toHaveAttribute('alt', 'Cover')
  await expect(page.locator('[data-writing-scene="b"] ul li')).toHaveText('Item')
})

for (const copy of [false, true]) {
  test(`internal cross-scene drag ${copy ? 'copies' : 'moves'} prose without consuming empty boundaries`, async ({ page }) => {
    await select(page)
    const result = await page.evaluate(copy => {
      const editor = window as unknown as EditorWindow
      const root = document.getElementById('editor')!
      const transfer = new DataTransfer()
      root.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }))
      const end = editor.getWritingSceneRoot('b')!.querySelector('p')!.firstChild!
      const target = document.createRange()
      target.setStart(end, end.textContent!.length)
      target.collapse(true)
      const rect = target.getBoundingClientRect()
      root.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: rect.x, clientY: rect.y + rect.height / 2, ctrlKey: copy, bubbles: true, cancelable: true }))
      return { html: ['a', 'b'].map(id => editor.serializeWritingScene(id)), transactions: editor.captureWritingChanges() }
    }, copy)
    await assertOwnership(page)
    await expect(page.locator('[data-writing-scene="a"]')).toHaveText(copy ? 'First scene.' : 'First ')
    await expect(page.locator('[data-writing-scene="b"]')).toContainText('scene.')
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].changes.map(change => change.ref.sceneId)).toEqual(copy ? ['b'] : ['a', 'b'])
    expect(result.html[1]).toContain('Second')
  })
}

test('a delayed image inserts into its captured source after the caret changes scenes', async ({ page }) => {
  await select(page, 'a', 3, 'a', 3)
  await page.evaluate(() => (window as unknown as ParityWindow).rememberImageTarget())
  await select(page, 'b', 3, 'b', 3)
  await page.evaluate(() => (window as unknown as EditorWindow).insertImageAtCaret('Images/captured.png', 'Captured'))
  await expect(page.locator('[data-writing-scene="a"] img')).toHaveAttribute('alt', 'Captured')
  await expect(page.locator('[data-writing-scene="b"] img')).toHaveCount(0)
  await assertOwnership(page)
})

test('book completion accepts Tab in an empty middle scene without touching neighbors', async ({ page }) => {
  await select(page, 'empty', 0, 'empty', 0)
  await page.evaluate(() => (window as unknown as EditorWindow).setCompletionList(['sovereign'], 3))
  await page.keyboard.type('sov')
  await expect(page.locator('#completion-picker.visible')).toContainText('sovereign')
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-writing-scene="empty"]')).toHaveText('sovereign')
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('First scene.')
  await expect(page.locator('[data-writing-scene="b"]')).toHaveText('Second scene.')
  await assertOwnership(page)
})

test('custom replacements use only the current scene and disabling restores literal input', async ({ page }) => {
  await select(page, 'empty', 0, 'empty', 0)
  await page.evaluate(() => (window as unknown as EditorWindow).setAutoReplacements(JSON.stringify([{ start: 'zz', startReplace: 'word' }])))
  await page.keyboard.type('zz')
  await expect(page.locator('[data-writing-scene="empty"]')).toHaveText('word')
  await page.evaluate(() => (window as unknown as EditorWindow).setAutoReplacements('[]'))
  await page.keyboard.type(' zz')
  await expect(page.locator('[data-writing-scene="empty"]')).toHaveText('word zz')
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('First scene.')
  await assertOwnership(page)
})

test('mention picker inserts its candidate into the active middle scene', async ({ page }) => {
  await select(page, 'empty', 0, 'empty', 0)
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setMentionLabels(JSON.stringify({ noMatches: 'No matches' }))
    editor.setMentionCandidates(JSON.stringify([{ primaryName: 'Ada', matchedText: 'Ada', entityId: 'ada-id', entityType: 'character', isAlias: false }]))
  })
  await page.keyboard.type('@Ad')
  await expect(page.locator('#mention-picker.visible')).toContainText('Ada')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-writing-scene="empty"] .nv-entity-mention')).toHaveAttribute('data-entity-id', 'ada-id')
  await expect(page.locator('[data-writing-scene="a"] .nv-entity-mention')).toHaveCount(0)
  await assertOwnership(page)
})

test('slash actions at an empty scene exclude preceding scenes from action context', async ({ page }) => {
  await select(page, 'empty', 0, 'empty', 0)
  await page.evaluate(() => (window as unknown as EditorWindow).setInlineActions(JSON.stringify([{ id: 'continue', label: 'Continue', allowsEmptySelection: true, slashKeyword: 'continue' }])))
  await page.keyboard.type('/continue')
  await expect(page.locator('#slash-picker.visible')).toContainText('Continue')
  await page.keyboard.press('Enter')
  const request = await page.evaluate(() => (window as unknown as ParityWindow).messages.filter(message => message.type === 'inlineActionRequested').at(-1))
  expect(request?.precedingText).toBe('')
  expect(request?.selectedText).toBe('')
  await page.evaluate(() => (window as unknown as EditorWindow).applyInlineActionResult(JSON.stringify({ actionId: 'continue', text: 'Continued.', disposition: 'insertAtCaret' })))
  await expect(page.locator('[data-writing-scene="empty"]')).toHaveText('Continued.')
  await expect(page.locator('[data-writing-scene="b"]')).toHaveText('Second scene.')
  await assertOwnership(page)
})

test('read aloud follows selected scene order while excluding empty scenes and chrome', async ({ page }) => {
  await select(page)
  const spoken = await page.evaluate(() => {
    const editor = window as unknown as ParityWindow
    const chrome = document.createElement('div')
    chrome.dataset.editorChrome = 'chapter'
    chrome.textContent = 'Chapter title'
    chrome.contentEditable = 'false'
    editor.getWritingSceneRoot('b')!.before(chrome)
    editor.startReadAloud(false, 1, 'parity-system-voice')
    editor.onSentenceSpoken(true)
    editor.onSentenceSpoken(true)
    editor.stopReadAloud()
    return { sentences: editor.messages.filter(message => message.type === 'speakSentence').map(message => message.text), changes: editor.captureWritingChanges() }
  })
  expect(spoken.sentences).toEqual(['First scene.', 'Second scene.'])
  expect(spoken.changes).toEqual([])
})

test('readability and compatibility text are scoped to the active scene', async ({ page }) => {
  await select(page, 'b', 2, 'b', 2)
  await page.evaluate(() => (window as unknown as EditorWindow).setReadabilityEnabled(true))
  await expect.poll(() => page.evaluate(() => (window as unknown as ParityWindow).messages.filter(message => message.type === 'readabilityRequest').at(-1)?.sceneId)).toBe('b')
  const result = await page.evaluate(() => {
    const editor = window as unknown as ParityWindow
    editor.setReadability(JSON.stringify({ sentences: [{ offset: 0, length: 6, level: 'hard' }], colors: { hard: 'yellow' } }))
    return { text: editor.getPlainText(), html: editor.getContent(), request: editor.messages.filter(message => message.type === 'readabilityRequest').at(-1)?.plainText, changes: editor.captureWritingChanges() }
  })
  expect(result.text).toBe('Second scene.')
  expect(result.html).toBe('<p>Second scene.</p>')
  expect(result.request).toBe('Second scene.')
  expect(result.changes).toEqual([])
})

test('theme and entity peek preserve prose ownership in a nonfirst scene', async ({ page }) => {
  await select(page, 'b', 2, 'b', 2)
  const result = await page.evaluate(() => {
    const editor = window as unknown as ParityWindow
    editor.setTheme('rgb(20, 20, 20)', 'rgb(240, 240, 240)', 'white', 'gray', 'black', 'white')
    editor.setEntityNames(JSON.stringify(['Second']))
    return { peek: editor.peekEntityAtCaret(), alias: editor.messages.filter(message => message.type === 'entityHover').at(-1)?.alias, changes: editor.captureWritingChanges() }
  })
  expect(result.peek).toBe(true)
  expect(result.alias).toBe('Second')
  expect(result.changes).toEqual([])
  await assertOwnership(page)
})

test('ornamental breaks remain unindented after load, editing and remote scene refresh without presentation writes', async ({ page }) => {
  const html = '<p id="ordinary">Ordinary prose.</p><p id="ornament">* * *</p>'
  await page.evaluate(({ snapshot, html }) => {
    const editor = window as unknown as EditorWindow
    editor.setWritingProjection([{ ...snapshot, html }], null)
    editor.setReadingComfort(1.7, 0, 0.75, 2)
  }, { snapshot: scenes[0], html })
  await expect(page.locator('#ordinary')).not.toHaveCSS('text-indent', '0px')
  await expect(page.locator('#ornament')).toHaveCSS('text-indent', '0px')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())).toEqual([])
  await page.evaluate(() => {
    document.getElementById('ornament')!.textContent = 'Ordinary again.'
    document.getElementById('editor')!.dispatchEvent(new Event('input'))
  })
  await expect(page.locator('#ornament')).not.toHaveCSS('text-indent', '0px')
  const transactions = await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())
  expect(transactions).toHaveLength(1)
  expect(transactions[0].changes[0].afterHtml).not.toContain('nv-scene-break')
  await page.evaluate(snapshot => (window as unknown as EditorWindow).updateWritingScene({ ...snapshot, html: '<p id="remote">***</p>', revision: 2 }), scenes[0])
  await expect(page.locator('#remote')).toHaveCSS('text-indent', '0px')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).captureWritingChanges())).toEqual([])
})

for (const insertion of ['typing', 'paste', 'inline'] as const) {
  test(`${insertion} replaces a fully selected first scene without jumping to its neighbor`, async ({ page }) => {
    await select(page, 'a', 0, 'b', 6)
    if (insertion === 'typing') await page.keyboard.type('X')
    else await page.evaluate(insertion => {
      const editor = window as unknown as ParityWindow
      if (insertion === 'inline') {
        editor.triggerInlineAction('rewrite')
        editor.applyInlineActionResult(JSON.stringify({ actionId: 'rewrite', text: 'X', disposition: 'replace' }))
      } else {
        const transfer = new DataTransfer()
        transfer.setData('text/html', '<p>X</p>')
        document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
      }
    }, insertion)
    await expect(page.locator('[data-writing-scene="a"]')).toHaveText('X')
    await expect(page.locator('[data-writing-scene="b"]')).toHaveText(' scene.')
    await expect(page.locator('[data-writing-scene="empty"]')).toHaveText('')
    await assertOwnership(page)
  })
}

test('internal rich drag preserves lists, links, images and paragraph styles', async ({ page }) => {
  const rich = '<p class="nv-style-poetry"><b>Rich</b> <a href="https://example.com">link</a><img src="Images/x.png" alt="Cover"></p><ul><li>Item</li></ul>'
  await page.evaluate(({ snapshot, rich }) => {
    const editor = window as unknown as EditorWindow
    editor.updateWritingScene({ ...snapshot, html: rich, revision: 1 })
    const root = document.getElementById('editor')!
    const source = document.createRange()
    source.selectNodeContents(editor.getWritingSceneRoot('a')!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(source)
    const transfer = new DataTransfer()
    root.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    const target = document.createRange()
    const end = editor.getWritingSceneRoot('b')!.querySelector('p')!.firstChild!
    target.setStart(end, end.textContent!.length)
    target.collapse(false)
    const rect = target.getBoundingClientRect()
    root.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: rect.x, clientY: rect.y + rect.height / 2, ctrlKey: true, bubbles: true, cancelable: true }))
  }, { snapshot: scenes[0], rich })
  await expect(page.locator('[data-writing-scene="b"] img')).toHaveAttribute('alt', 'Cover')
  await expect(page.locator('[data-writing-scene="b"] a')).toHaveAttribute('href', 'https://example.com')
  await expect(page.locator('[data-writing-scene="b"] .nv-style-poetry')).toContainText('Rich link')
  await expect(page.locator('[data-writing-scene="b"] ul li')).toHaveText('Item')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).serializeWritingScene('a'))).toBe(rich)
  await assertOwnership(page)
})

for (const partial of [false, true]) for (const copy of [false, true]) test(`${partial ? 'partial inline' : 'annotated'} native drag ${copy ? 'copy' : 'move'} binds fresh marker identities to its prose transaction`, async ({ page }) => {
  const html = '<p><span class="nv-comment" data-comment-id="same"><b>Alpha Beta</b></span><sup class="nv-fn" data-fn-id="same">1</sup></p>'
  const result = await page.evaluate(({ snapshot, html, copy, partial }) => {
    const editor = window as unknown as EditorWindow
    editor.updateWritingScene({ ...snapshot, html, revision: 1 })
    editor.updateWritingScene({ ...snapshot, sceneId: 'b', html: html + '<p>Target</p>', revision: 1 })
    const root = document.getElementById('editor')!
    const source = document.createRange()
    source.selectNodeContents(editor.getWritingSceneRoot('a')!)
    if (partial) {
      source.setStart(editor.getWritingSceneRoot('a')!.querySelector('b')!.firstChild!, 6)
      source.setEnd(source.startContainer, 10)
    }
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(source)
    const transfer = new DataTransfer()
    root.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    const target = document.createRange()
    target.setStart(editor.getWritingSceneRoot('b')!.lastElementChild!.firstChild!, 6)
    target.collapse(true)
    const rect = target.getBoundingClientRect()
    root.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: rect.x, clientY: rect.y + rect.height / 2, ctrlKey: copy, bubbles: true, cancelable: true }))
    return { transactions: editor.captureWritingChanges(), source: editor.serializeWritingScene('a'), target: editor.serializeWritingScene('b') }
  }, { snapshot: scenes[0], html, copy, partial })
  expect(result.transactions).toHaveLength(1)
  const transfers = result.transactions[0].annotationTransfers!
  expect(transfers).toHaveLength(partial ? 1 : 2)
  expect(transfers.map(transfer => transfer.kind)).toEqual(partial ? ['comment'] : ['comment', 'footnote'])
  for (const transfer of transfers) {
    expect(transfer.from).toEqual({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'a' })
    expect(transfer.to.sceneId).toBe('b')
    expect(transfer.move).toBe(!copy)
    expect(transfer.expectedSourceRevision).toBe(1)
    expect(transfer.sourceHtml).toBe(html)
    expect(transfer.targetId).not.toBe('same')
    expect(result.target).toContain(transfer.targetId)
  }
  expect(result.target).toContain('data-comment-id="same"')
  expect(result.target).toContain('data-fn-id="same"')
  if (copy) expect(result.source).toBe(html)
  else if (partial) expect(result.source).toContain('<b>Alpha </b>')
  else expect(result.source).not.toContain('data-comment-id')
  if (partial) await expect(page.locator(`[data-writing-scene="b"] [data-comment-id="${transfers[0].targetId}"] b`)).toHaveText('Beta')
  await assertOwnership(page)
})

test('dictation survives native proofing and page changes while the visible caret moves to another scene', async ({ page }) => {
  await select(page, 'a', 5, 'a', 5)
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.captureDictationAnchor('review')
    editor.setGrammarCheckEnabled(true)
    editor.setGrammarIssues(JSON.stringify([{ offset: 0, length: 11, type: 'grammar', message: 'Fixture', replacements: [] }]))
    editor.setPageView(false)
    editor.setGrammarIssues('[]')
    editor.setPageView(true)
  })
  await select(page, 'b', 2, 'b', 2)
  expect(await page.evaluate(() => (window as unknown as EditorWindow).insertDictationText('review', 'spoken', false, '', ''))).toBe(true)
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('First spoken scene.')
  await expect(page.locator('[data-writing-scene="b"]')).toHaveText('Second scene.')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getWritingSelection()?.focus.sceneId)).toBe('b')
})

test('a delayed inline result applies to its captured scene after the native caret changes scenes', async ({ page }) => {
  await select(page, 'a', 0, 'a', 5)
  await page.evaluate(() => (window as unknown as ParityWindow).triggerInlineAction('rewrite'))
  await select(page, 'b', 2, 'b', 2)
  await page.evaluate(() => (window as unknown as EditorWindow).applyInlineActionResult(JSON.stringify({ actionId: 'rewrite', text: 'Rewritten', disposition: 'replace' })))
  await expect(page.locator('[data-writing-scene="a"]')).toHaveText('Rewritten scene.')
  await expect(page.locator('[data-writing-scene="b"]')).toHaveText('Second scene.')
  await assertOwnership(page)
})
