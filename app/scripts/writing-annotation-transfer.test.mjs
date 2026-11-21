import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import createDOMPurify from 'dompurify'

const require = createRequire(import.meta.url)
const result = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/views/editor/writingAnnotationTransfers'; export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/renderer/src/collaboration/SharedWritingHistory'; export * from './src/renderer/src/collaboration/sharedWritingAnnotations'; export * from './src/shared/ProseDocumentHost'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { WritingDocumentRegistry, acceptWritingTransaction, getWritingHistory, resolveWritingAnnotationTransfers } = module.exports
const { SharedSceneSession, SharedWritingHistory, SharedWritingAnnotations, mergeSharedAnnotations, ProseDocumentHost, acceptSharedWritingBatch, sceneRefKey } = module.exports
const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
const ref = sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId })
const markup = (commentId = 'same', noteId = 'same', text = 'Alpha', number = 1) => `<p><span class="nv-comment" data-comment-id="${commentId}">${text}</span><sup class="nv-fn" data-fn-id="${noteId}">${number}</sup></p>`
const annotations = sceneId => ({ comments: [{ id: 'same', anchorText: sceneId === 'a' ? 'Alpha' : 'Existing', text: `${sceneId} comment`, resolved: false, author: 'Original author', replies: [{ id: 'reply', text: 'Reply', author: 'Peer', createdAt: '2026-11-01T00:00:00Z' }] }], footnotes: [{ id: 'same', number: 1, text: `${sceneId} footnote` }] })

async function fixture(t, contents = {}, records = {}) {
  const dom = new JSDOM()
  const editor = { sanitizeSceneFragment: html => {
    const template = dom.window.document.createElement('template')
    template.innerHTML = html
    return template.content
  } }
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
    read: async reference => ({ html: contents[reference.sceneId] ?? markup('same', 'same', reference.sceneId === 'a' ? 'Alpha' : 'Existing'), hash: reference.sceneId, annotations: records[reference.sceneId] ?? annotations(reference.sceneId) }),
    activate: async () => true,
    commit: async request => ({ status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
  } })
  await Promise.all(['a', 'b'].map(id => registry.read(ref(id))))
  t.after(async () => { await registry.close(); dom.window.close() })
  return { registry, editor }
}

function transaction(registry, mode) {
  const source = registry.getSnapshot(ref('a'))
  const target = registry.getSnapshot(ref('b'))
  const move = mode !== 'copy'
  const sourceAfter = mode === 'partial' ? '<p><span class="nv-comment" data-comment-id="same">Al</span></p>' : '<p><br></p>'
  const changes = [...(move ? [{ scene: source, html: sourceAfter }] : []), { scene: target, html: target.html + markup('copied-comment', 'copied-note', mode === 'partial' ? 'pha' : 'Alpha', 2) }]
  return { id: crypto.randomUUID(), context, origin: 'writer', kind: 'input',
    changes: changes.map(({ scene, html }) => ({ ref: ref(scene.sceneId), expectedRevision: scene.revision, expectedHash: scene.hash, beforeHtml: scene.html, afterHtml: html })),
    annotationChanges: [], beforeSelection: null, afterSelection: null,
    annotationTransfers: [['comment', 'copied-comment'], ['footnote', 'copied-note']].map(([kind, targetId]) => ({ from: ref('a'), to: ref('b'), kind, sourceId: 'same', targetId, move, expectedSourceRevision: source.revision, sourceHtml: source.html })) }
}

for (const mode of ['move', 'copy', 'partial']) test(`annotated ${mode} preserves both scenes' colliding IDs and complete records through one undo/redo`, async t => {
  const { registry, editor } = await fixture(t)
  const before = registry.capture().map(scene => scene.html)
  const resolved = resolveWritingAnnotationTransfers(registry, transaction(registry, mode), editor)
  acceptWritingTransaction(registry, resolved)
  const source = registry.getAnnotations(ref('a'))
  const target = registry.getAnnotations(ref('b'))
  assert.equal(target.comments.find(comment => comment.id === 'same').text, 'b comment')
  assert.deepEqual(target.comments.find(comment => comment.id === 'copied-comment'), { ...annotations('a').comments[0], id: 'copied-comment', anchorText: mode === 'partial' ? 'pha' : 'Alpha' })
  assert.deepEqual(target.footnotes.find(note => note.id === 'copied-note'), { id: 'copied-note', number: 2, text: 'a footnote' })
  assert.equal(source.comments.length, mode === 'move' ? 0 : 1)
  if (mode === 'partial') assert.equal(source.comments[0].anchorText, 'Al')
  assert.equal(source.footnotes.length, mode === 'copy' ? 1 : 0)
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  assert.deepEqual(registry.capture().map(scene => scene.html), before)
  for (const id of ['a', 'b']) assert.deepEqual(registry.getAnnotations(ref(id)), annotations(id))
  assert.equal((await getWritingHistory(registry).redo()).status, 'applied')
  assert.equal(registry.getAnnotations(ref('b')).comments.find(comment => comment.id === 'copied-comment').text, 'a comment')
})

for (const failure of ['revision', 'identity', 'collision', 'missing-marker']) test(`annotation transfer rejects ${failure} before changing prose or metadata`, async t => {
  const { registry, editor } = await fixture(t)
  const tx = transaction(registry, 'copy')
  if (failure === 'revision') tx.annotationTransfers[0].expectedSourceRevision++
  if (failure === 'identity') tx.annotationTransfers[0].from.chapterGuid = 'different-chapter'
  if (failure === 'collision') tx.annotationTransfers[0].targetId = 'same'
  if (failure === 'missing-marker') tx.annotationTransfers[0].targetId = 'missing'
  const before = registry.capture().map(scene => scene.html)
  assert.throws(() => resolveWritingAnnotationTransfers(registry, tx, editor))
  assert.deepEqual(registry.capture().map(scene => scene.html), before)
  for (const id of ['a', 'b']) assert.deepEqual(registry.getAnnotations(ref(id)), annotations(id))
})

for (const copy of [false, true]) test(`actual partial inline drag ${copy ? 'copy' : 'move'} preserves formatting and annotation records through capture, resolution and undo`, async t => {
  const html = '<p><span class="nv-comment" data-comment-id="same"><b>Alpha Beta</b></span></p>'
  const original = { comments: [{ ...annotations('a').comments[0], anchorText: 'Alpha Beta' }], footnotes: [] }
  const { registry, editor } = await fixture(t, { a: html }, { a: original })
  const dom = new JSDOM('<div id="editor" contenteditable="true"></div>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.NovalistEditorState = { editor: w.document.getElementById('editor') }
  w.DOMPurify = createDOMPurify(w)
  w.sendMessage = () => {}
  w.toDisplayImages = () => {}
  w.cleanContentRoot = root => root.innerHTML
  for (const name of ['scene-sanitizer', 'scene-html', 'writing-selection', 'writing-document', 'writing-transactions', 'writing-drag-drop']) {
    w.eval(readFileSync(new URL(`../src/renderer/public/editor/${name}.js`, import.meta.url), 'utf8'))
  }
  w.setWritingContext(context, 'writer')
  w.setWritingProjection(registry.capture(), null)
  const root = w.NovalistEditorState.editor
  const source = w.document.createRange()
  source.setStart(w.getWritingSceneRoot('a').querySelector('b').firstChild, 6)
  source.setEnd(source.startContainer, 10)
  w.getSelection().addRange(source)
  const data = new Map()
  const transfer = { getData: type => data.get(type) ?? '', setData: (type, value) => data.set(type, value), dropEffect: copy ? 'copy' : 'move' }
  const dispatch = type => {
    const event = new w.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, type === 'copy' ? 'clipboardData' : 'dataTransfer', { value: transfer })
    root.dispatchEvent(event)
  }
  dispatch('copy')
  assert.match(data.get('text/html'), /<span[^>]*data-comment-id="same"[^>]*><b>Beta<\/b><\/span>/)
  dispatch('dragstart')
  assert.equal(data.get('text/plain'), 'Beta')
  assert.match(data.get('text/html'), /<b>Beta<\/b>/)
  assert.equal(data.get('text/html').includes('Alpha'), false)
  const target = w.document.createRange()
  target.setStart(w.getWritingSceneRoot('b').firstChild, 1)
  target.collapse(true)
  w.document.elementFromPoint = () => w.getWritingSceneRoot('b').firstChild
  w.document.caretRangeFromPoint = () => target.cloneRange()
  dispatch('drop')
  const captured = JSON.parse(JSON.stringify(w.captureWritingChanges()))
  assert.equal(captured.length, 1)
  assert.equal(captured[0].annotationTransfers.length, 1)
  const transferred = captured[0].annotationTransfers[0]
  assert.equal(transferred.sourceId, 'same')
  assert.equal(transferred.move, !copy)
  assert.equal(w.getWritingSceneRoot('b').querySelector(`[data-comment-id="${transferred.targetId}"] b`).textContent, 'Beta')
  const resolved = resolveWritingAnnotationTransfers(registry, captured[0], editor)
  acceptWritingTransaction(registry, resolved)
  assert.deepEqual(registry.getAnnotations(ref('b')).comments.find(comment => comment.id === transferred.targetId), {
    ...original.comments[0], id: transferred.targetId, anchorText: 'Beta'
  })
  assert.equal(registry.getAnnotations(ref('b')).comments.find(comment => comment.id === 'same').text, 'b comment')
  assert.equal(registry.getAnnotations(ref('a')).comments[0].anchorText, copy ? 'Alpha Beta' : 'Alpha ')
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  assert.equal(registry.getSnapshot(ref('a')).html, html)
  assert.deepEqual(registry.getAnnotations(ref('a')), original)
  assert.deepEqual(registry.getAnnotations(ref('b')), annotations('b'))
  assert.equal((await getWritingHistory(registry).redo()).status, 'applied')
  assert.equal(registry.getAnnotations(ref('b')).comments.find(comment => comment.id === transferred.targetId).anchorText, 'Beta')
})

for (const sharedIds of [['a'], ['b'], ['a', 'b']]) test(`annotated move with shared ${sharedIds.join('+')} preserves one mixed history action`, async t => {
  const dom = new JSDOM()
  const environment = { document: dom.window.document, toDisplayImages() {}, sanitizeSceneFragment: html => {
    const template = dom.window.document.createElement('template')
    template.innerHTML = html
    return template.content
  } }
  const host = new ProseDocumentHost(environment.document, environment)
  const owners = new Map()
  for (const id of sharedIds) {
    const state = host.seed(id, markup('same', 'same', id === 'a' ? 'Alpha' : 'Existing'))
    owners.set(id, new SharedSceneSession(environment, state, { read: async () => host.state(id), write: async update => { host.receive(id, update) }, subscribe: () => () => {} }))
  }
  const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
    read: async reference => ({ html: owners.get(reference.sceneId)?.html ?? markup('same', 'same', reference.sceneId === 'a' ? 'Alpha' : 'Existing'), hash: reference.sceneId,
      shared: owners.has(reference.sceneId) ? { sessionId: 'session', itemId: reference.sceneId, state: '' } : null, annotations: annotations(reference.sceneId) }),
    activate: async () => true, commit: async request => ({ status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: change.afterHtml })) })
  } })
  await Promise.all(['a', 'b'].map(id => registry.read(ref(id))))
  const serverAnnotations = new Map(sharedIds.map(id => [id, annotations(id)]))
  const metadata = new SharedWritingAnnotations(async request => ({ status: 'committed', operationId: request.transactionId,
    annotations: request.changes.map(change => {
      const next = mergeSharedAnnotations(serverAnnotations.get(change.ref.sceneId), change)
      serverAnnotations.set(change.ref.sceneId, next)
      return { ref: change.ref, annotations: next }
    }) }))
  const history = new SharedWritingHistory()
  t.after(async () => {
    history.dispose()
    await metadata.close()
    await registry.close()
    for (const owner of owners.values()) await owner.close()
    host.dispose()
    dom.window.close()
  })
  const resolved = resolveWritingAnnotationTransfers(registry, transaction(registry, 'move'), environment, owners)
  acceptSharedWritingBatch(registry, [{ registry, transaction: resolved }], history,
    new Map([...owners].map(([id, owner]) => [sceneRefKey(ref(id)), owner])), { annotations: metadata })
  await metadata.flush()
  assert.equal(registry.getAnnotations(ref('a')).comments.length, 0)
  assert.equal(registry.getAnnotations(ref('b')).comments.find(comment => comment.id === 'copied-comment').text, 'a comment')
  assert.equal((await getWritingHistory(registry).undo()).status, 'applied')
  await metadata.flush()
  for (const id of ['a', 'b']) {
    assert.deepEqual(registry.getAnnotations(ref(id)), annotations(id))
    assert.equal(owners.get(id)?.html ?? registry.getSnapshot(ref(id)).html, markup('same', 'same', id === 'a' ? 'Alpha' : 'Existing'))
  }
  assert.equal((await getWritingHistory(registry).redo()).status, 'applied')
  assert.equal(registry.getAnnotations(ref('a')).comments.length, 0)
  assert.equal(registry.getAnnotations(ref('b')).comments.find(comment => comment.id === 'copied-comment').text, 'a comment')
})
