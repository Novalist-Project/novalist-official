import type { WritingDocumentRegistry } from '../../stores/writingDocuments'
import { acceptWritingTransaction } from '../../stores/writingHistory'
import { useShellStore } from '../../stores/shellStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { EditorMessage, EditorWindow } from './editorBridge'
import type { SceneRef, WritingAnnotations, WritingTransaction } from './writingTypes'

export function pushWritingAnnotations(editor: EditorWindow, registry: WritingDocumentRegistry, ref: SceneRef): void {
  const annotations = registry.getAnnotations(ref)
  if (!annotations) return
  editor.setCommentsData(annotations.comments)
  editor.setFootnotesData(annotations.footnotes)
}

export function applyWritingAnnotations(editor: EditorWindow, registry: WritingDocumentRegistry,
  ref: SceneRef, after: WritingAnnotations, origin: string,
  accept: (transaction: WritingTransaction) => void = transaction => acceptWritingTransaction(registry, transaction)): void {
  applyAnnotationBatch(editor, registry, [{ ref, after }], origin, accept)
}

function applyAnnotationBatch(editor: EditorWindow, registry: WritingDocumentRegistry,
  updates: { ref: SceneRef; after: WritingAnnotations }[], origin: string,
  accept: (transaction: WritingTransaction) => void): void {
  const changes = updates.map(({ ref, after }) => {
    const before = registry.getAnnotations(ref)
    if (!before) throw new Error('writing.annotationsUnavailable')
    return { ref, before, after }
  })
  const transactions = editor.captureWritingChanges()
  const last = transactions.pop() ?? {
    id: crypto.randomUUID(), context: registry.context, origin, kind: 'input', changes: [], annotationChanges: [],
    beforeSelection: editor.getWritingSelection(), afterSelection: editor.getWritingSelection()
  } satisfies WritingTransaction
  for (const transaction of transactions) accept(transaction)
  last.annotationChanges.push(...changes)
  accept(last)
}

function newComment(commentId: unknown, anchorText: unknown): WritingAnnotations['comments'][number] {
  return { id: String(commentId), anchorText: String(anchorText ?? ''), text: '', resolved: false,
    createdAt: new Date().toISOString(), author: useSettingsStore.getState().view?.project?.author ?? null,
    isTodo: false, verdict: null, replies: null }
}

function addCommentBatch(message: EditorMessage, editor: EditorWindow, registry: WritingDocumentRegistry,
  refs: ReadonlyMap<string, SceneRef>, origin: string, accept: (transaction: WritingTransaction) => void): void {
  if (!Array.isArray(message.comments)) throw new Error('writing.annotationsUnavailable')
  const updates = message.comments.map((comment: { sceneId: string; commentId: string; anchorText: string }) => {
    const ref = refs.get(comment.sceneId)
    if (!ref) throw new Error('writing.annotationSceneUnavailable')
    const after = registry.getAnnotations(ref)
    if (!after) throw new Error('writing.annotationsUnavailable')
    after.comments.push(newComment(comment.commentId, comment.anchorText))
    return { ref, after }
  })
  applyAnnotationBatch(editor, registry, updates, origin, accept)
  const active = refs.get(editor.getWritingSelection()?.focus.sceneId ?? '')
  if (active) pushWritingAnnotations(editor, registry, active)
}

export function handleWritingAnnotationMessage(message: EditorMessage, editor: EditorWindow,
  registry: WritingDocumentRegistry, refs: ReadonlyMap<string, SceneRef>, origin: string,
  accept?: (transaction: WritingTransaction) => void): boolean {
  if (message.type === 'commentsAdded') {
    addCommentBatch(message, editor, registry, refs, origin, accept ?? (transaction => acceptWritingTransaction(registry, transaction)))
    return true
  }
  const handled = ['commentAdded', 'commentTextChanged', 'commentDeleted', 'footnoteInserted', 'footnotesRenumbered']
  if (!handled.includes(message.type)) return false
  const sceneId = typeof message.sceneId === 'string' ? message.sceneId : editor.getWritingSelection()?.focus.sceneId
  const ref = sceneId ? refs.get(sceneId) : undefined
  if (!ref) throw new Error('writing.annotationSceneUnavailable')
  const after = registry.getAnnotations(ref)
  if (!after) throw new Error('writing.annotationsUnavailable')
  if (message.type === 'commentAdded') after.comments.push(newComment(message.commentId, message.anchorText))
  if (message.type === 'commentTextChanged') {
    const comment = after.comments.find(value => value.id === message.commentId)
    if (comment) comment.text = String(message.text ?? '')
  }
  if (message.type === 'commentDeleted') {
    after.comments = after.comments.filter(value => value.id !== message.commentId)
    editor.removeCommentById(String(message.commentId))
  }
  if (message.type === 'footnoteInserted' || message.type === 'footnotesRenumbered') {
    const ids = Array.isArray(message.ids) ? message.ids.map(String) : []
    after.footnotes = ids.map((id, index) => ({
      id, number: index + 1, text: after.footnotes.find(note => note.id === id)?.text ?? ''
    }))
  }
  applyWritingAnnotations(editor, registry, ref, after, origin, accept)
  if (editor.getWritingSelection()?.focus.sceneId === ref.sceneId) pushWritingAnnotations(editor, registry, ref)
  if (message.type === 'footnoteInserted') useShellStore.getState().requestFootnoteText(String(message.footnoteId))
  return true
}
