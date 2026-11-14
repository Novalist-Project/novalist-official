import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

function runtime(t) {
  const dom = new JSDOM('<div id="editor" contenteditable="true"></div>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.NovalistEditorState = { editor: w.document.getElementById('editor') }
  w.sendMessage = () => {}
  w.sceneContentFragment = html => { const template = w.document.createElement('template'); template.innerHTML = html; return template.content }
  w.toDisplayImages = () => {}
  w.clearGrammarHighlights = () => {}
  for (const file of ['writing-selection', 'writing-document', 'writing-transactions', 'content-input']) {
    w.eval(readFileSync(new URL(`../src/renderer/public/editor/${file}.js`, import.meta.url), 'utf8'))
  }
  w.setWritingContext({ workspaceId: 'w', workspaceEpoch: 1, bookId: 'b', draftId: 'd' }, 'pane')
  const snapshots = ['one', 'two'].map(sceneId => ({ bookId: 'b', draftId: 'd', chapterGuid: 'c', sceneId,
    html: `<p data-author="writer">${sceneId} &amp; prose</p>`, hash: 'h', revision: 0 }))
  w.setWritingProjection(snapshots, null)
  return { w, snapshots }
}

test('unchanged global captures avoid cloning scene DOM but synchronous text and attribute edits remain live', t => {
  const { w, snapshots } = runtime(t)
  const clean = w.cleanContentRoot
  const cleaned = []
  w.cleanContentRoot = root => { cleaned.push(root.dataset.writingScene); return clean(root) }
  for (let index = 0; index < 10; index++) for (const snapshot of snapshots) {
    assert.equal(w.serializeWritingScene(snapshot.sceneId), snapshot.html)
  }
  assert.deepEqual(cleaned, [], 'global capture must reuse unchanged observed scenes')
  const paragraph = w.getWritingSceneRoot('one').querySelector('p')
  paragraph.firstChild.appendData(' typed')
  assert.match(w.serializeWritingScene('one'), /typed<\/p>$/)
  paragraph.setAttribute('data-author', 'new writer')
  assert.match(w.serializeWritingScene('one'), /data-author="new writer"/)
  assert.equal(w.serializeWritingScene('two'), snapshots[1].html)
  assert.deepEqual(cleaned, ['one', 'one'])
  assert.equal(w.captureWritingChanges().length, 1)
  cleaned.length = 0
  assert.match(w.serializeWritingScene('one'), /typed<\/p>$/)
  assert.deepEqual(cleaned, [])
})

test('remote rendering, presentation wrappers, and undo projections never return stale cached prose', t => {
  const { w, snapshots } = runtime(t)
  const remote = { ...snapshots[0], html: '<p><b>Remote</b> prose</p>', revision: 1 }
  w.updateWritingScene(remote)
  assert.equal(w.serializeWritingScene('one'), remote.html)
  assert.equal(w.captureWritingChanges().length, 0)
  w.NovalistEditorState.pageViewEnabled = true
  const root = w.getWritingSceneRoot('one')
  const page = w.document.createElement('div')
  page.className = 'nv-page'
  page.append(...root.childNodes)
  root.append(page)
  assert.equal(w.serializeWritingScene('one'), remote.html)
  assert.equal(w.captureWritingChanges().length, 0)
  w.updateWritingScene({ ...snapshots[0], revision: 2 })
  assert.equal(w.serializeWritingScene('one'), snapshots[0].html)
  root.querySelector('p').append(' current')
  assert.match(w.serializeWritingScene('one'), / current<\/p>$/)
  assert.equal(w.captureWritingChanges()[0].changes[0].expectedRevision, 2)
})
