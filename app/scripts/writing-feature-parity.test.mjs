import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { loadRendererSource } from './renderer-source-loader.mjs'

function editor() {
  const dom = new JSDOM('<div id="editor" contenteditable="true"></div>', { runScripts: 'outside-only' })
  const w = dom.window
  w.NovalistEditorState = { editor: w.document.getElementById('editor') }
  w.sendMessage = () => {}
  w.sceneContentFragment = html => {
    const template = w.document.createElement('template')
    template.innerHTML = html
    return template.content
  }
  w.toDisplayImages = () => {}
  w.cleanContentRoot = root => root.innerHTML
  w.isCompositionInput = () => false
  w.document.execCommand = (command, _ui, text) => {
    assert.equal(command, 'insertText')
    const range = w.getSelection().getRangeAt(0)
    range.deleteContents()
    const node = w.document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    return true
  }
  for (const file of ['writing-selection', 'writing-document', 'writing-transactions', 'inline-actions', 'inline-action-state', 'dictation-bridge', 'suggestion-events']) {
    w.eval(readFileSync(new URL(`../src/renderer/public/editor/${file}.js`, import.meta.url), 'utf8'))
  }
  w.setWritingContext({ workspaceId: 'w', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'pane')
  w.setWritingProjection([scene('a', '<p>First</p>'), scene('empty', '<p><br></p>'), scene('b', '<p>Second</p>')], null)
  return w
}
const scene = (sceneId, html, revision = 0) => ({ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId, html, hash: 'h', revision })
const point = (sceneId, offset) => ({ sceneId, offset, affinity: 'after' })

test('inline replacement partitions a captured cross-scene range into one owned transaction', () => {
  const w = editor()
  try {
    w.restoreWritingSelection({ anchor: point('a', 2), focus: point('b', 3) })
    w.triggerInlineAction('rewrite')
    w.applyInlineActionResult(JSON.stringify({ actionId: 'rewrite', text: 'new', disposition: 'replace' }))
    assert.deepEqual([...w.NovalistEditorState.editor.children].map(node => node.dataset.writingScene), ['a', 'empty', 'b'])
    assert.equal(w.getWritingSceneRoot('a').textContent, 'Finew')
    assert.equal(w.getWritingSceneRoot('b').textContent, 'ond')
    const transactions = w.captureWritingChanges()
    assert.equal(transactions.length, 1)
    assert.deepEqual(Array.from(transactions[0].changes, change => change.ref.sceneId), ['a', 'b'])
  } finally { w.close() }
})

test('dictation rejects an anchor whose scene content was replaced', () => {
  const w = editor()
  try {
    w.restoreWritingSelection({ anchor: point('a', 2), focus: point('a', 2) })
    assert.equal(w.captureDictationAnchor('voice'), true)
    w.updateWritingScene(scene('a', '<p>Remote version</p>', 1))
    assert.equal(w.insertDictationText('voice', 'late', false, '', ''), false)
    assert.equal(w.getWritingSceneRoot('a').textContent, 'Remote version')
    assert.equal(w.captureWritingChanges().length, 0)
  } finally { w.close() }
})

test('dictation has no implicit whole-root fallback when the projection has no caret', () => {
  const w = editor()
  try {
    w.getSelection().removeAllRanges()
    assert.equal(w.captureDictationAnchor('voice'), false)
    assert.equal(w.insertDictationText('voice', 'late', false, '', ''), false)
    assert.equal(w.captureWritingChanges().length, 0)
  } finally { w.close() }
})

test('dictation remains anchored to its source after the visible caret moves to another scene', () => {
  const w = editor()
  try {
    w.restoreWritingSelection({ anchor: point('a', 5), focus: point('a', 5) })
    w.captureDictationAnchor('voice')
    w.restoreWritingSelection({ anchor: point('b', 2), focus: point('b', 2) })
    assert.equal(w.insertDictationText('voice', 'spoken', false, '', ''), true)
    assert.equal(w.getWritingSceneRoot('a').textContent, 'First spoken')
    assert.equal(w.getWritingSceneRoot('b').textContent, 'Second')
    assert.equal(w.getWritingSelection().focus.sceneId, 'b')
  } finally { w.close() }
})

test('trusted proofing restores the dictation endpoint but cannot revive a replaced source block', () => {
  const w = editor()
  try {
    for (const file of ['grammar-highlights', 'dictation']) w.eval(readFileSync(new URL(`../src/renderer/public/editor/${file}.js`, import.meta.url), 'utf8'))
    w.getContainingBlock = node => (node.nodeType === 3 ? node.parentElement : node).closest('p')
    w.restoreWritingSelection({ anchor: point('a', 2), focus: point('a', 2) })
    w.captureDictationAnchor('voice')
    const saved = w.captureDictationPosition()
    const highlight = w.document.createElement('span')
    highlight.className = 'grammar-issue'
    highlight.textContent = saved.node.textContent
    saved.node.replaceWith(highlight)
    w.restoreDictationPosition(saved, true)
    const decorated = w.captureDictationPosition()
    highlight.replaceWith(...highlight.childNodes)
    saved.block.normalize()
    w.restoreDictationPosition(decorated, true)
    w.restoreWritingSelection({ anchor: point('b', 2), focus: point('b', 2) })
    assert.equal(w.insertDictationText('voice', 'spoken', false, '', ''), true)
    assert.equal(w.getWritingSceneRoot('a').textContent, 'Fi spokenrst')
    assert.equal(w.getWritingSelection().focus.sceneId, 'b')
    const replaced = w.captureDictationPosition()
    w.updateWritingScene(scene('a', '<p>Replacement</p>', 1))
    w.restoreDictationPosition(replaced, true)
    assert.equal(w.insertDictationText('voice', 'late', false, '', ''), false)
    assert.equal(w.getWritingSceneRoot('a').textContent, 'Replacement')
  } finally { w.close() }
})

test('duplicate suggestion identifiers navigate only in the caret scene', () => {
  const w = editor()
  try {
    const html = '<p><ins data-nl-change="same">Proposed</ins></p>'
    w.setWritingProjection([scene('a', html), scene('b', html)], null)
    w.restoreWritingSelection({ anchor: point('b', 2), focus: point('b', 2) })
    const targets = []
    for (const id of ['a', 'b']) w.getWritingSceneRoot(id).querySelector('ins').scrollIntoView = () => targets.push(id)
    w.scrollToSuggestionById('same')
    assert.deepEqual(targets, ['b'])
    assert.equal(w.getWritingSceneRoot('a').querySelector('.nv-change-flash'), null)
  } finally { w.close() }
})

test('inline action context excludes preceding scenes and structural chrome', () => {
  const w = editor()
  try {
    const messages = []
    w.sendMessage = message => messages.push(message)
    const chrome = w.document.createElement('div')
    chrome.dataset.editorChrome = 'chapter'
    chrome.textContent = 'Chapter title'
    w.getWritingSceneRoot('b').before(chrome)
    w.restoreWritingSelection({ anchor: point('b', 2), focus: point('b', 4) })
    w.triggerInlineAction('rewrite')
    assert.equal(messages.at(-1).precedingText, 'Se')
    w.restoreWritingSelection({ anchor: point('a', 2), focus: point('b', 3) })
    w.triggerInlineAction('rewrite')
    assert.equal(messages.at(-1).selectedText.includes('Chapter title'), false)
  } finally { w.close() }
})

test('a delayed bare-caret action rejects scene replacement even when its selection was empty', () => {
  const w = editor()
  try {
    w.NovalistEditorState.inlineActions = [{ id: 'continue', allowsEmptySelection: true }]
    w.restoreWritingSelection({ anchor: point('a', 2), focus: point('a', 2) })
    w.triggerInlineAction('continue')
    w.updateWritingScene(scene('a', '<p>Replacement</p>', 1))
    w.applyInlineActionResult(JSON.stringify({ actionId: 'continue', text: 'late', disposition: 'insertAtCaret' }))
    assert.equal(w.getWritingSceneRoot('a').textContent, 'Replacement')
    assert.equal(w.captureWritingChanges().length, 0)
  } finally { w.close() }
})

test('a delayed image retains the originating scene when the caret moves', () => {
  const w = editor()
  try {
    w.NovalistEditorState.dismissedGrammarIssues = new Set()
    for (const name of ['applyGrammarHighlights', 'hideGrammarPopup', 'requestGrammarCheck', 'updateGrammarStatusBar']) w[name] = () => {}
    w.caretBlock = () => w.getSelection().anchorNode.parentElement
    w.eval(readFileSync(new URL('../src/renderer/public/editor/content-input.js', import.meta.url), 'utf8'))
    w.restoreWritingSelection({ anchor: point('a', 2), focus: point('a', 2) })
    w.setSceneContext('a')
    w.rememberImageTarget()
    w.restoreWritingSelection({ anchor: point('b', 2), focus: point('b', 2) })
    w.setSceneContext('b')
    w.insertImageAtCaret('Images/picture.png', 'Picture')
    assert.equal(w.getWritingSceneRoot('a').querySelector('img')?.getAttribute('alt'), 'Picture')
    assert.equal(w.getWritingSceneRoot('b').querySelector('img'), null)
  } finally { w.close() }
})

function readabilityFixture() {
  const w = editor()
  const requests = []
  w.NovalistEditorState.READABILITY_BANDS = ['hard']
  w.NovalistEditorState.readabilityHighlights = { hard: new Set() }
  w.buildGrammarPlainTextMap = () => {
    const node = w.getWritingSceneRoot().firstChild.firstChild
    return { plainText: node.textContent, textNodes: [{ node, start: 0, end: node.textContent.length }] }
  }
  w.eval(readFileSync(new URL('../src/renderer/public/editor/readability.js', import.meta.url), 'utf8'))
  const { createEditorProofingMessages } = loadRendererSource('src/views/editor/editorProofingMessages.ts', {
    '../../stores/settingsStore': {}, '../../stores/editorBridgeStore': {}, '../../shell/useSpellCheck': {},
    '../../proofing/grammar': {}, './editorConfiguration': { hardBandColors: () => ({ hard: 'yellow' }) },
    '../../rpc/client': { rpc: { request: (_method, _params, options) => new Promise((resolve, reject) => requests.push({ resolve, reject, options })) } }
  }, { AbortController })
  const handlers = createEditorProofingMessages({ editorRef: { current: w } })
  w.sendMessage = message => { if (message.type === 'readabilityRequest') handlers.readabilityRequest(message) }
  w.restoreWritingSelection({ anchor: point('a', 1), focus: point('a', 1) })
  w.setReadabilityEnabled(true)
  return { w, requests }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

test('the actual inline-action handler preserves its captured source when the unified caret changes scenes', async () => {
  const w = editor()
  try {
    w.NovalistEditorState.dismissedGrammarIssues = new Set()
    for (const name of ['applyGrammarHighlights', 'hideGrammarPopup', 'requestGrammarCheck', 'updateGrammarStatusBar']) w[name] = () => {}
    w.eval(readFileSync(new URL('../src/renderer/public/editor/content-input.js', import.meta.url), 'utf8'))
    let currentScene = 'a'
    w.cleanContentRoot = root => root.innerHTML
    let finish
    const { createEditorActionMessages } = loadRendererSource('src/views/editor/editorActionMessages.ts', {
      './InlineActionDialog': {}, './editorBridge': { runInlineAction: () => new Promise(resolve => { finish = resolve }) },
      '../../stores/projectStore': {}, '../../stores/writingZoomStore': {}, '../../shell/hotkeys': {}, '../../rpc/client': {}
    })
    const handlers = createEditorActionMessages({ editorRef: { current: w }, paneIds: () => ({ sceneId: currentScene }), writing: {} })
    w.sendMessage = message => { if (message.type === 'inlineActionRequested') handlers.inlineActionRequested(message) }
    w.setSceneContext('a')
    w.restoreWritingSelection({ anchor: point('a', 0), focus: point('a', 5) })
    w.triggerInlineAction('rewrite')
    currentScene = 'b'
    w.restoreWritingSelection({ anchor: point('b', 2), focus: point('b', 2) })
    w.setSceneContext('b')
    finish({ text: 'Rewritten', disposition: 'replace' })
    await settle()
    assert.equal(w.getWritingSceneRoot('a').textContent, 'Rewritten')
    assert.equal(w.getWritingSceneRoot('b').textContent, 'Second')
    assert.equal(w.captureWritingChanges().length, 1)
  } finally { w.close() }
})

test('the actual readability handler ignores an earlier response after newer text was graded', async () => {
  const { w, requests } = readabilityFixture()
  try {
    await settle()
    w.getWritingSceneRoot('a').firstChild.firstChild.data = 'Edited text'
    w.requestReadability(0)
    await settle()
    requests[1].resolve([{ offset: 0, length: 6, level: 'hard' }])
    await settle()
    requests[0].resolve([{ offset: 0, length: 2, level: 'hard' }])
    await settle()
    assert.equal(w.NovalistEditorState.lastReadabilityGrading[0].length, 6)
    assert.equal(requests[0].options.signal.aborted, true)
  } finally { w.close() }
})

test('readability responses cannot return to an obsolete A-to-B-to-A request', async () => {
  const { w, requests } = readabilityFixture()
  try {
    await settle()
    for (const id of ['b', 'a']) {
      w.restoreWritingSelection({ anchor: point(id, 1), focus: point(id, 1) })
      w.requestReadability(0)
      await settle()
    }
    requests[2].resolve([{ offset: 0, length: 3, level: 'hard' }])
    await settle()
    requests[0].resolve([{ offset: 0, length: 1, level: 'hard' }])
    requests[1].reject(new Error('Late unavailable reply'))
    await settle()
    assert.equal(w.NovalistEditorState.lastReadabilityGrading[0].length, 3)
  } finally { w.close() }
})

test('readability rejects a changed scene revision even before another request is sent', async () => {
  const { w, requests } = readabilityFixture()
  try {
    await settle()
    w.updateWritingScene(scene('a', '<p>New revision</p>', 1))
    requests[0].resolve([{ offset: 0, length: 2, level: 'hard' }])
    await settle()
    assert.equal(w.NovalistEditorState.lastReadabilityGrading ?? null, null)
  } finally { w.close() }
})

function dragEditor() {
  const w = editor()
  w.DOMPurify = createDOMPurify(w)
  for (const file of ['scene-sanitizer', 'scene-html', 'clipboard-focus', 'writing-drag-drop']) {
    w.eval(readFileSync(new URL(`../src/renderer/public/editor/${file}.js`, import.meta.url), 'utf8'))
  }
  return w
}

test('internal rich drag preserves allowed list, link, image and paragraph style markup', () => {
  const w = dragEditor()
  try {
    const rich = '<p class="nv-style-poetry"><b>Rich</b> <a href="https://example.com">link</a><img src="Images/x.png" alt="Cover"></p><ul><li>Item</li></ul>'
    w.setWritingProjection([scene('a', rich), scene('b', '<p>Target</p>')], null)
    const root = w.NovalistEditorState.editor
    const source = w.document.createRange()
    source.selectNodeContents(w.getWritingSceneRoot('a'))
    w.getSelection().removeAllRanges()
    w.getSelection().addRange(source)
    const data = new Map()
    const transfer = { getData: type => data.get(type) || '', setData: (type, value) => data.set(type, value), dropEffect: 'copy' }
    const dispatch = type => {
      const event = new w.Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      root.dispatchEvent(event)
    }
    dispatch('dragstart')
    const target = w.document.createRange()
    target.selectNodeContents(w.getWritingSceneRoot('b').firstChild)
    target.collapse(false)
    w.document.elementFromPoint = () => w.getWritingSceneRoot('b').firstChild
    w.document.caretRangeFromPoint = () => target.cloneRange()
    w.document.execCommand = (command, _ui, html) => {
      assert.equal(command, 'insertHTML')
      w.getSelection().getRangeAt(0).insertNode(w.getSelection().getRangeAt(0).createContextualFragment(html))
      return true
    }
    dispatch('drop')
    const destination = w.getWritingSceneRoot('b')
    assert.equal(destination.querySelector('img')?.getAttribute('alt'), 'Cover')
    assert.equal(destination.querySelector('a')?.getAttribute('href'), 'https://example.com')
    assert.equal(destination.querySelector('.nv-style-poetry')?.textContent, 'Rich link')
    assert.equal(destination.querySelector('ul li')?.textContent, 'Item')
    assert.equal(w.getWritingSceneRoot('a').innerHTML, rich)
  } finally { w.close() }
})

test('external drops are handled once and cannot fall through to the legacy document listener', () => {
  const w = dragEditor()
  try {
    const root = w.NovalistEditorState.editor
    const target = w.document.createRange()
    target.selectNodeContents(w.getWritingSceneRoot('b').firstChild)
    target.collapse(false)
    w.document.elementFromPoint = () => w.getWritingSceneRoot('b').firstChild
    w.document.caretRangeFromPoint = () => target.cloneRange()
    w.document.execCommand = (_command, _ui, html) => {
      w.getSelection().getRangeAt(0).insertNode(w.getSelection().getRangeAt(0).createContextualFragment(html))
      return true
    }
    const event = new w.Event('drop', { bubbles: true, cancelable: true })
    const html = '<section data-writing-scene="forged"><p class="nv-style-poetry"><a href="https://example.com">Dropped</a><img src="Images/x.png" alt="Cover" onerror="evil()"></p><ul><li>Item</li></ul><script>evil()</script></section>'
    Object.defineProperty(event, 'dataTransfer', { value: { getData: type => type === 'text/html' ? html : '' } })
    root.dispatchEvent(event)
    const destination = w.getWritingSceneRoot('b')
    assert.equal(destination.querySelectorAll('.nv-style-poetry').length, 1)
    assert.equal(destination.querySelector('.nv-style-poetry a')?.getAttribute('href'), 'https://example.com')
    assert.equal(destination.querySelector('img')?.getAttribute('alt'), 'Cover')
    assert.equal(destination.querySelector('ul li')?.textContent, 'Item')
    assert.equal(destination.querySelector('[onerror],script'), null)
    assert.equal(destination.querySelector('[data-writing-scene]'), null)
    assert.equal(destination.textContent, 'SecondDroppedItem')
  } finally { w.close() }
})
