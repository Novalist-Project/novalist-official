import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

function editor(extraScripts = []) {
  const dom = new JSDOM('<div id="editor" contenteditable="true"></div>', { runScripts: 'outside-only' })
  const w = dom.window
  w.NovalistEditorState = { editor: w.document.getElementById('editor') }
  w.sendMessage = () => {}
  w.sceneContentFragment = html => {
    const template = w.document.createElement('template'); template.innerHTML = html; return template.content
  }
  w.toDisplayImages = () => {}
  w.isCompositionInput = () => false
  w.cleanContentRoot = root => root.innerHTML
  for (const file of ['writing-selection', 'writing-document', 'writing-transactions', ...extraScripts]) {
    w.eval(readFileSync(new URL(`../src/renderer/public/editor/${file}.js`, import.meta.url), 'utf8'))
  }
  w.setWritingContext({ workspaceId: 'w', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'pane')
  return w
}
const scene = (sceneId, html) => ({ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId, html, hash: 'h', revision: 0 })
const point = (sceneId, offset) => ({ sceneId, offset, affinity: 'after' })

test('a cross-scene comment emits one scene-qualified annotation batch without moving scene roots', () => {
  const w = editor(['annotations', 'comment-bridge'])
  const messages = []
  w.sendMessage = message => messages.push(message)
  w.setWritingProjection([scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')], null)
  w.restoreWritingSelection({ anchor: point('s1', 2), focus: point('s2', 3) })
  w.addCommentToSelection('comment')
  const comments = messages.filter(message => message.type === 'commentAdded' || message.type === 'commentsAdded')
  assert.equal(comments.length, 1)
  assert.equal(comments[0].type, 'commentsAdded')
  assert.deepEqual(Array.from(comments[0].comments, comment => [comment.sceneId, comment.anchorText]), [['s1', 'rst'], ['s2', 'Sec']])
  assert.equal(w.getWritingSceneRoot('s1').querySelector('[data-comment-id="comment"]').textContent, 'rst')
  assert.equal(w.getWritingSceneRoot('s2').querySelector('[data-comment-id="comment"]').textContent, 'Sec')
  assert.equal(w.NovalistEditorState.editor.children.length, 2)
  w.close()
})

test('tracked deletion across scenes preserves both scene roots and all proposed text', () => {
  const w = editor(['suggestions', 'suggestion-events'])
  w.setWritingProjection([scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')], null)
  const roots = [w.getWritingSceneRoot('s1'), w.getWritingSceneRoot('s2')]
  w.setSuggestionMode(true, 'Writer')
  w.restoreWritingSelection({ anchor: point('s1', 2), focus: point('s2', 3) })
  w.NovalistEditorState.editor.dispatchEvent(new w.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }))
  assert.equal(roots[0].parentElement, w.NovalistEditorState.editor)
  assert.equal(roots[1].parentElement, w.NovalistEditorState.editor)
  assert.equal(roots[0].textContent, 'First')
  assert.equal(roots[1].textContent, 'Second')
  assert.equal(roots[0].querySelector('del')?.textContent, 'rst')
  assert.equal(roots[1].querySelector('del')?.textContent, 'Sec')
  assert.equal(w.captureWritingChanges()[0].changes.length, 2)
  w.close()
})

test('projection preserves raw canonical HTML and stable unchanged roots across scopes', () => {
  const w = editor()
  const first = scene('s1', '<p data-author="yes">A &amp; B</p>\n<p>Second.</p>')
  const second = scene('s2', '<p>Other</p>')
  w.setWritingProjection([first, second], null)
  const root = w.getWritingSceneRoot('s1')
  assert.equal(w.serializeWritingScene('s1'), first.html)
  w.setWritingProjection([first], null)
  assert.equal(w.getWritingSceneRoot('s1'), root)
  assert.equal(w.captureWritingChanges().length, 0)
  w.close()
})

test('refreshing an unchanged projection keeps scene chrome and prose nodes in place', () => {
  const w = editor()
  const scenes = [scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')]
  w.setWritingProjection(scenes, null)
  for (const id of ['s1', 's2']) {
    const chrome = w.document.createElement('div')
    chrome.dataset.editorChrome = 'writing'
    chrome.contentEditable = 'false'
    w.getWritingSceneRoot(id).before(chrome)
  }
  const before = [...w.NovalistEditorState.editor.children]
  const observer = new w.MutationObserver(() => {})
  observer.observe(w.NovalistEditorState.editor, { childList: true })
  w.setWritingProjection(scenes, null)
  assert.deepEqual([...w.NovalistEditorState.editor.children], before)
  assert.equal(observer.takeRecords().length, 0)
  observer.disconnect()
  w.close()
})

test('reverse Unicode selections use canonical paragraph and BR offsets', () => {
  const w = editor()
  w.setWritingProjection([scene('s1', '<p>A<strong>\uD83D\uDE00B</strong><br>C</p>'), scene('s2', '<p>End</p>')], null)
  const selection = { anchor: point('s2', 2), focus: point('s1', 4) }
  w.restoreWritingSelection(selection)
  assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection())), selection)
  assert.equal(w.writingSceneText(w.getWritingSceneRoot('s1')), 'A\uD83D\uDE00B\nC\n')
  w.close()
})

test('structural split captures only its scene and preserves nested rich blocks without editing', () => {
  const w = editor()
  const source = '<h2>Title</h2><p>A<strong>bold text</strong> end</p><ul><li>Later</li></ul>'
  w.setWritingProjection([scene('s1', '<p>Previous</p>'), scene('s2', source), scene('s3', '<p>Next</p>')], null)
  const split = w.captureWritingSplit(point('s2', 10))
  assert.equal(split.sourceHtml, source)
  assert.equal(split.beforeHtml, '<h2>Title</h2><p>A<strong>bold</strong></p>')
  assert.equal(split.afterHtml, '<p><strong> text</strong> end</p><ul><li>Later</li></ul>')
  assert.equal(w.serializeWritingScene('s2'), source)
  assert.equal(w.captureWritingChanges().length, 0)
  assert.equal(w.captureWritingSplit(point('s2', 0)).beforeHtml, '<p><br></p>')
  w.close()
})

test('cross-scene deletion preserves empty identities and captures only touched scenes', () => {
  const w = editor()
  w.setWritingProjection([scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>'), scene('s3', '<p>Hidden</p>')], null)
  w.restoreWritingSelection({ anchor: point('s1', 2), focus: point('s2', 3) })
  w.NovalistEditorState.editor.dispatchEvent(new w.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }))
  const [tx] = w.captureWritingChanges()
  assert.deepEqual(Array.from(tx.changes, x => x.ref.sceneId), ['s1', 's2'])
  assert.deepEqual(Array.from(w.NovalistEditorState.editor.querySelectorAll('[data-writing-scene]'), el => el.dataset.writingScene), ['s1', 's2', 's3'])
  assert.equal(w.serializeWritingScene('s1'), '<p>Fi</p>')
  assert.equal(w.serializeWritingScene('s2'), '<p>ond</p>')
  assert.equal(w.serializeWritingScene('s3'), '<p>Hidden</p>')
  w.close()
})

test('composition pins projection and captures final text before deferred scope change', () => {
  const w = editor()
  const first = scene('s1', '<p>Initial</p>')
  w.setWritingProjection([first], null)
  w.NovalistEditorState.isComposing = true
  w.getWritingSceneRoot('s1').firstChild.textContent = '\u4E2D\u6587'
  w.setWritingProjection([scene('s2', '<p>Next</p>')], null)
  assert.ok(w.getWritingSceneRoot('s1').isConnected)
  w.NovalistEditorState.isComposing = false
  w.flushWritingProjection()
  const [tx] = w.captureWritingChanges()
  assert.equal(tx.changes[0].afterHtml, '<p>\u4E2D\u6587</p>')
  assert.equal(w.getWritingSceneRoot('s2').isConnected, true)
  w.close()
})

test('expanding scope during composition cannot overwrite the pinned scene with its earlier snapshot', () => {
  const w = editor()
  const first = scene('s1', '<p>Initial</p>')
  w.setWritingProjection([first], null)
  w.NovalistEditorState.isComposing = true
  w.getWritingSceneRoot('s1').firstChild.textContent = '\u4E2D\u6587'
  w.setWritingProjection([first, scene('s2', '<p>Next</p>')], null)
  w.NovalistEditorState.isComposing = false
  w.flushWritingProjection()
  assert.equal(w.serializeWritingScene('s1'), '<p>\u4E2D\u6587</p>')
  assert.equal(w.captureWritingChanges()[0].changes[0].afterHtml, '<p>\u4E2D\u6587</p>')
  w.close()
})

test('ordinary cross-scene edits skip hidden scenes and retain empty list boundaries', () => {
  const w = editor()
  const snapshots = [scene('s1', '<ul><li>First</li></ul>'), scene('s2', '<p>Hidden</p>'), scene('s3', '<p>Last</p>')]
  w.setWritingProjection(snapshots, null)
  w.setWritingProjection([snapshots[0], snapshots[2]], null)
  w.restoreWritingSelection({ anchor: point('s3', 4), focus: point('s1', 0) })
  w.deleteWritingSelection()
  const [tx] = w.captureWritingChanges()
  assert.deepEqual(Array.from(tx.changes, change => change.ref.sceneId), ['s1', 's3'])
  assert.equal(w.serializeWritingScene('s2'), '<p>Hidden</p>')
  assert.equal(w.getWritingSceneRoot('s1').isConnected, true)
  assert.equal(w.getWritingSceneRoot('s3').isConnected, true)
  w.close()
})

test('a shared save acknowledgement cannot normalize away newer uncaptured typing', () => {
  const w = editor()
  const snapshot = scene('s1', '<p>Saved</p>')
  w.setWritingProjection([snapshot], null)
  w.getWritingSceneRoot('s1').firstChild.append(' newly typed')
  w.acknowledgeWritingScene(snapshot)
  assert.equal(w.captureWritingChanges()[0]?.changes[0].afterHtml, '<p>Saved newly typed</p>')
  w.close()
})

test('native select-all deletes prose without deleting any scene container', () => {
  const w = editor()
  w.setWritingProjection([scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')], null)
  const range = w.document.createRange()
  range.selectNodeContents(w.NovalistEditorState.editor)
  w.getSelection().addRange(range)
  assert.equal(w.deleteWritingSelection(), true)
  assert.equal(w.NovalistEditorState.editor.querySelectorAll('[data-writing-scene]').length, 2)
  assert.deepEqual(Array.from(w.captureWritingChanges()[0].changes, change => change.ref.sceneId), ['s1', 's2'])
  assert.equal(w.getWritingSceneRoot('s1').textContent, '')
  assert.equal(w.getWritingSceneRoot('s2').textContent, '')
  w.close()
})

test('forward and reverse cross-scene bookmarks survive narrowed and empty projections', () => {
  for (const reverse of [false, true]) {
    const w = editor()
    const scenes = [scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')]
    w.setWritingProjection(scenes, null)
    const endpoints = [point('s1', 2), point('s2', 3)]
    const selection = { anchor: endpoints[reverse ? 1 : 0], focus: endpoints[reverse ? 0 : 1] }
    w.restoreWritingSelection(selection)
    w.setWritingProjection([scenes[1]], null)
    w.getWritingSelection()
    w.setWritingProjection([], null)
    w.getWritingSelection()
    w.setWritingProjection(scenes, null)
    assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection())), selection)
    w.close()
  }
})

test('a user selection or edit in a narrowed projection supersedes its hidden bookmark', () => {
  for (const action of ['move', 'edit', 'composition']) {
    const w = editor()
    const scenes = [scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')]
    w.setWritingProjection(scenes, null)
    w.restoreWritingSelection({ anchor: point('s1', 2), focus: point('s2', 3) })
    w.setWritingProjection([scenes[1]], null)
    if (action === 'move') {
      const text = w.getWritingSceneRoot('s2').firstChild.firstChild
      w.getSelection().setBaseAndExtent(text, 1, text, 1)
    } else {
      w.NovalistEditorState.editor.dispatchEvent(action === 'edit'
        ? new w.InputEvent('beforeinput', { inputType: 'insertText', bubbles: true })
        : new w.CompositionEvent('compositionstart', { bubbles: true }))
    }
    const chosen = JSON.parse(JSON.stringify(w.getWritingSelection()))
    w.setWritingProjection(scenes, null)
    assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection())), chosen)
    w.close()
  }
})

test('synopsis chrome input and navigation preserve the prose bookmark through projection changes', () => {
  for (const event of ['pointerdown', 'beforeinput', 'compositionstart', 'cut', 'paste', 'keydown']) {
    const w = editor()
    const scenes = [scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')]
    w.setWritingProjection(scenes, null)
    const selection = { anchor: point('s2', 4), focus: point('s1', 2) }
    w.restoreWritingSelection(selection)
    const chrome = w.document.createElement('aside')
    chrome.setAttribute('data-editor-chrome', '')
    chrome.contentEditable = 'false'
    const synopsis = w.document.createElement('textarea')
    chrome.append(synopsis)
    w.NovalistEditorState.editor.prepend(chrome)
    synopsis.focus()
    w.getSelection().removeAllRanges()
    synopsis.dispatchEvent(event === 'keydown' ? new w.KeyboardEvent(event, { key: 'ArrowLeft', bubbles: true })
      : new w.Event(event, { bubbles: true }))
    assert.equal(w.getWritingSelection(), null, 'chrome does not expose a live prose selection')
    assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection(true))), selection, event)
    chrome.remove()
    w.getSelection().setBaseAndExtent(w.NovalistEditorState.editor, 0, w.NovalistEditorState.editor, 0)
    w.getWritingSelection()
    w.setWritingProjection([scenes[1]], null)
    w.setWritingProjection(scenes, null)
    assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection())), selection, event)
    assert.equal(w.captureWritingChanges().length, 0)
    const chosen = { anchor: point('s1', 1), focus: point('s1', 1) }
    w.restoreWritingSelection(chosen)
    assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection(true))), chosen, 'explicit navigation replaces the chrome bookmark')
    w.setWritingProjection(scenes, null)
    assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection())), chosen, 'explicit prose navigation replaces the bookmark')
    w.close()
  }
})

test('a prose bookmark cannot cross writing contexts or pane runtimes', () => {
  const oldPane = editor(), newPane = editor()
  oldPane.setWritingProjection([scene('s1', '<p>First</p>')], null)
  oldPane.restoreWritingSelection({ anchor: point('s1', 2), focus: point('s1', 2) })
  const chrome = oldPane.document.createElement('textarea')
  chrome.setAttribute('data-editor-chrome', '')
  oldPane.NovalistEditorState.editor.prepend(chrome)
  chrome.dispatchEvent(new oldPane.Event('pointerdown', { bubbles: true }))
  assert.throws(() => oldPane.setWritingContext({ workspaceId: 'w', workspaceEpoch: 2, bookId: 'b', draftId: 'd' }, 'pane'),
    /Writing context requires a new pane runtime/)
  newPane.setWritingProjection([scene('s1', '<p>First</p>')], null)
  assert.equal(newPane.getWritingSelection(true), null)
  oldPane.close()
  newPane.close()
})

test('visible scene refresh preserves hidden forward/reverse bookmarks until explicit navigation', () => {
  for (const reverse of [false, true]) for (const navigate of [false, true]) {
    const w = editor()
    const scenes = [scene('s1', '<p>First</p>'), scene('s2', '<p>Second</p>')]
    w.setWritingProjection(scenes, null)
    const endpoints = [point('s1', 2), point('s2', 3)]
    const selection = { anchor: endpoints[reverse ? 1 : 0], focus: endpoints[reverse ? 0 : 1] }
    w.restoreWritingSelection(selection)
    w.setWritingProjection([scenes[1]], null)
    const updated = { ...scenes[1], html: '<p>Second remotely updated</p>', revision: 1 }
    w.updateWritingScene(updated)
    w.getWritingSelection()
    const chosen = { anchor: point('s2', 1), focus: point('s2', 1) }
    if (navigate) w.restoreWritingSelection(chosen)
    w.setWritingProjection([scenes[0], updated], null)
    assert.deepEqual(JSON.parse(JSON.stringify(w.getWritingSelection())), navigate ? chosen : selection)
    assert.equal(w.serializeWritingScene('s2'), updated.html)
    w.close()
  }
})
