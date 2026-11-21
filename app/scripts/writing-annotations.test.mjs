import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendererSource } from './renderer-source-loader.mjs'

test('one cross-scene comment joins both annotation records and prose changes in one history action', () => {
  const refs = ['first', 'second'].map(sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId }))
  const before = { comments: [], footnotes: [] }
  const transactions = []
  const subject = loadRendererSource('src/views/editor/writingAnnotationMessages.ts', {
    '../../stores/writingHistory': { acceptWritingTransaction: (_owner, tx) => transactions.push(tx) },
    '../../stores/shellStore': { useShellStore: { getState: () => ({}) } },
    '../../stores/settingsStore': { useSettingsStore: { getState: () => ({ view: { project: { author: 'Writer' } } }) } }
  }, { crypto })
  const prose = { id: 'prose', changes: refs.map(ref => ({ ref, beforeHtml: '<p>Text</p>', afterHtml: '<p><span class="nv-comment" data-comment-id="c">Text</span></p>' })), annotationChanges: [] }
  const registry = { getAnnotations: () => structuredClone(before) }
  const editor = { captureWritingChanges: () => [prose], getWritingSelection: () => null }
  assert.equal(subject.handleWritingAnnotationMessage({ type: 'commentsAdded', comments: refs.map(ref => ({ sceneId: ref.sceneId, commentId: 'c', anchorText: 'Text' })) },
    editor, registry, new Map(refs.map(ref => [ref.sceneId, ref])), 'writer'), true)
  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].changes.length, 2)
  assert.deepEqual(transactions[0].annotationChanges.map(change => change.ref), refs)
  for (const change of transactions[0].annotationChanges) {
    assert.equal(change.before.comments.length, 0)
    assert.equal(change.after.comments[0].author, 'Writer')
    assert.equal(change.after.comments[0].id, 'c')
  }
})

test('annotation edits retain provenance and new comments capture writer metadata before saving', () => {
  const recorded = []
  const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
  const original = { id: 'existing', anchorText: 'Words', text: 'Old', resolved: false,
    createdAt: '2020-01-01T00:00:00Z', author: 'Original writer', isTodo: true, verdict: 'accepted',
    replies: [{ id: 'reply', author: 'Peer', text: 'Keep me', createdAt: '2020-01-02T00:00:00Z' }] }
  let annotations = { comments: [original], footnotes: [] }
  const registry = { context: { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' },
    getAnnotations: () => structuredClone(annotations) }
  const module = loadRendererSource('src/views/editor/writingAnnotationMessages.ts', {
    '../../stores/writingHistory': { acceptWritingTransaction(_registry, transaction) {
      recorded.push(transaction)
      annotations = structuredClone(transaction.annotationChanges[0].after)
    } },
    '../../stores/shellStore': { useShellStore: { getState: () => ({ requestFootnoteText() {} }) } },
    '../../stores/settingsStore': { useSettingsStore: { getState: () => ({ view: { project: { author: 'Current writer' } } }) } }
  }, { crypto })
  const editor = { captureWritingChanges: () => [], getWritingSelection: () => null,
    removeCommentById() {}, setCommentsData() {}, setFootnotesData() {} }
  const refs = new Map([['scene', ref]])
  module.handleWritingAnnotationMessage({ type: 'commentTextChanged', sceneId: 'scene', commentId: 'existing', text: 'Changed' }, editor, registry, refs, 'writer')
  assert.deepEqual(annotations.comments[0], { ...original, text: 'Changed' })
  module.handleWritingAnnotationMessage({ type: 'commentDeleted', sceneId: 'scene', commentId: 'existing' }, editor, registry, refs, 'writer')
  assert.deepEqual(recorded[1].annotationChanges[0].before.comments[0], { ...original, text: 'Changed' })
  assert.equal(annotations.comments.length, 0)
  module.handleWritingAnnotationMessage({ type: 'commentAdded', sceneId: 'scene', commentId: 'new', anchorText: 'New' }, editor, registry, refs, 'writer')
  assert.equal(annotations.comments[0].author, 'Current writer')
  assert.equal(Number.isNaN(Date.parse(annotations.comments[0].createdAt)), false)
  assert.equal(annotations.comments[0].isTodo, false)
  assert.equal(annotations.comments[0].replies, null)
})

test('the footnote inspector opens only after its annotation transaction is accepted', () => {
  const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
  let annotations = { comments: [], footnotes: [] }
  const requested = []
  const registry = { context: { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' },
    getAnnotations: () => structuredClone(annotations) }
  const subject = loadRendererSource('src/views/editor/writingAnnotationMessages.ts', {
    '../../stores/writingHistory': { acceptWritingTransaction: (_registry, transaction) => {
      annotations = structuredClone(transaction.annotationChanges[0].after)
    } },
    '../../stores/shellStore': { useShellStore: { getState: () => ({ requestFootnoteText(id) {
      assert.ok(annotations.footnotes.some(note => note.id === id))
      requested.push(id)
    } }) } },
    '../../stores/settingsStore': { useSettingsStore: { getState: () => ({}) } }
  }, { crypto })
  const editor = { captureWritingChanges: () => [], getWritingSelection: () => null }
  const message = { type: 'footnoteInserted', sceneId: 'scene', footnoteId: 'accepted', ids: ['accepted'] }
  const refs = new Map([['scene', ref]])
  subject.handleWritingAnnotationMessage(message, editor, registry, refs, 'writer')
  assert.deepEqual(requested, ['accepted'])
  assert.throws(() => subject.handleWritingAnnotationMessage({ ...message, footnoteId: 'rejected', ids: ['accepted', 'rejected'] },
    editor, registry, refs, 'writer', () => { throw new Error('Transaction rejected') }), /Transaction rejected/)
  assert.deepEqual(requested, ['accepted'], 'a rejected transaction must not move focus to a nonexistent row')
})
