import { sceneRefKey, type WritingDocumentRegistry } from '../../stores/writingDocuments'
import type { EditorWindow } from './editorBridge'
import type { AnnotationChange, SceneRef, WritingAnnotationTransfer, WritingTransaction } from './writingTypes'
import type { SharedSceneSession } from '../../collaboration/SharedSceneSession'

export function resolveWritingAnnotationTransfers(registry: WritingDocumentRegistry, transaction: WritingTransaction,
  editor: EditorWindow, shared: ReadonlyMap<string, SharedSceneSession> = new Map()): WritingTransaction {
  if (!transaction.annotationTransfers?.length) return transaction
  const validateLocal = (value: WritingTransaction): void => registry.validate({ ...value,
    changes: value.changes.filter(change => !registry.getSnapshot(change.ref)?.shared),
    annotationChanges: value.annotationChanges.filter(change => !registry.getSnapshot(change.ref)?.shared) })
  const snapshot = (ref: SceneRef): { html: string; revision: number } => {
    const scene = registry.getSnapshot(ref)
    if (!scene) throw new Error('writing.annotationSceneUnavailable')
    const owner = scene.shared ? shared.get(ref.sceneId) : scene
    if (!owner) throw new Error('writing.annotationSceneUnavailable')
    return owner
  }
  validateLocal(transaction)
  const updates = new Map(transaction.annotationChanges.map(change => [sceneRefKey(change.ref), structuredClone(change)]))
  const fragments = new Map<string, DocumentFragment>()
  const update = (ref: SceneRef): AnnotationChange => {
    const key = sceneRefKey(ref)
    let change = updates.get(key)
    if (!change) {
      const before = registry.getAnnotations(ref)
      if (!before) throw new Error('writing.annotationsUnavailable')
      change = { ref, before, after: structuredClone(before) }
      updates.set(key, change)
    }
    return change
  }
  const fragment = (ref: SceneRef): DocumentFragment => {
    const key = sceneRefKey(ref)
    let root = fragments.get(key)
    if (!root) {
      const html = transaction.changes.find(change => sceneRefKey(change.ref) === key)?.afterHtml ?? snapshot(ref).html
      root = editor.sanitizeSceneFragment(html)
      fragments.set(key, root)
    }
    return root
  }
  for (const transfer of transaction.annotationTransfers) {
    const source = snapshot(transfer.from)
    if (source.revision !== transfer.expectedSourceRevision || source.html !== transfer.sourceHtml) throw new Error('writing.conflict')
    const destination = update(transfer.to)
    if (!transaction.changes.some(change => sceneRefKey(change.ref) === sceneRefKey(transfer.to))) throw new Error('writing.annotationSceneUnavailable')
    transferRecord(transfer, update(transfer.from), destination, fragment)
  }
  const resolved = { ...transaction }
  delete resolved.annotationTransfers
  resolved.annotationChanges = [...updates.values()].filter(change => JSON.stringify(change.before) !== JSON.stringify(change.after))
  validateLocal(resolved)
  return resolved
}

function markerNodes(root: DocumentFragment, kind: WritingAnnotationTransfer['kind'], id: string): Element[] {
  const attribute = kind === 'comment' ? 'data-comment-id' : 'data-fn-id'
  return Array.from(root.querySelectorAll(`[${attribute}]`)).filter(node => node.getAttribute(attribute) === id)
}

function transferRecord(transfer: WritingAnnotationTransfer, source: AnnotationChange, destination: AnnotationChange,
  fragment: (ref: SceneRef) => DocumentFragment): void {
  const target = fragment(transfer.to)
  const markers = markerNodes(target, transfer.kind, transfer.targetId)
  if (!markers.length) throw new Error('writing.annotationsUnavailable')
  const remaining = markerNodes(fragment(transfer.from), transfer.kind, transfer.sourceId)
  if (transfer.kind === 'comment') {
    const original = source.before.comments.find(comment => comment.id === transfer.sourceId)
    if (!original || destination.after.comments.some(comment => comment.id === transfer.targetId)) throw new Error('writing.annotationsUnavailable')
    destination.after.comments.push({ ...structuredClone(original), id: transfer.targetId, anchorText: markers.map(node => node.textContent).join('') })
    if (transfer.move) {
      source.after.comments = source.after.comments.filter(comment => comment.id !== transfer.sourceId || remaining.length)
      const retained = source.after.comments.find(comment => comment.id === transfer.sourceId)
      if (retained) retained.anchorText = remaining.map(node => node.textContent).join('')
    }
  } else {
    const original = source.before.footnotes.find(note => note.id === transfer.sourceId)
    if (!original || destination.after.footnotes.some(note => note.id === transfer.targetId)) throw new Error('writing.annotationsUnavailable')
    destination.after.footnotes.push({ ...original, id: transfer.targetId })
    if (transfer.move && !remaining.length) source.after.footnotes = source.after.footnotes.filter(note => note.id !== transfer.sourceId)
    for (const change of new Set([source, destination])) {
      const ids = Array.from(fragment(change.ref).querySelectorAll('sup.nv-fn[data-fn-id]'), marker => marker.getAttribute('data-fn-id'))
      for (const note of change.after.footnotes) if (ids.includes(note.id)) note.number = ids.indexOf(note.id) + 1
    }
  }
}
