import { sceneRefKey, type WritingDocumentRegistry } from './writingDocuments'
import type { SceneRef, WritingTransaction, HistoryInverse } from '../views/editor/writingTypes'

export interface WritingHistoryPart {
  registry: WritingDocumentRegistry
  transaction: WritingTransaction
  inverse: Extract<HistoryInverse, { kind: 'local' }>
}

export interface WritingHistoryRebase {
  before: SceneRef
  after: SceneRef | null
  expectedHtml?: string
  expectedHash?: string
}

export function prepareHistoryRebase(parts: readonly WritingHistoryPart[], previous: WritingDocumentRegistry,
  next: WritingDocumentRegistry, changes: readonly WritingHistoryRebase[]): Map<WritingHistoryPart, WritingHistoryPart> {
  if (previous.context.workspaceId !== next.context.workspaceId || previous.context.bookId !== next.context.bookId || previous.context.draftId !== next.context.draftId) {
    throw new Error('Writing history can only rebind within its writer and book session.')
  }
  const mapping = new Map(changes.map(change => [sceneRefKey(change.before), change]))
  const before = new Map(previous.capture().map(snapshot => [sceneRefKey(snapshot), snapshot]))
  const prepared = new Map<WritingHistoryPart, WritingHistoryPart>()
  const remap = (ref: SceneRef): SceneRef => {
    const change = mapping.get(sceneRefKey(ref))
    const target = change?.after ?? ref
    if (change?.after === null) return { ...ref }
    const snapshot = next.getSnapshot(target)
    const expected = change?.expectedHtml ?? before.get(sceneRefKey(ref))?.html
    if (!snapshot || expected === undefined || snapshot.html !== expected || (change?.expectedHash && snapshot.hash !== change.expectedHash)) {
      throw new Error('Writing history rebind requires verified current document snapshots.')
    }
    return { ...target }
  }
  for (const part of parts) {
    if (part.registry !== previous) continue
    const transaction = structuredClone(part.transaction)
    transaction.context = { ...next.context }
    transaction.changes = transaction.changes.map(change => ({ ...change, ref: remap(change.ref) }))
    transaction.annotationChanges = transaction.annotationChanges.map(change => ({ ...change, ref: remap(change.ref) }))
    const inverse = structuredClone(part.inverse)
    inverse.changes = inverse.changes.map(change => ({ ...change, ref: remap(change.ref) }))
    inverse.annotationChanges = inverse.annotationChanges.map(change => ({ ...change, ref: remap(change.ref) }))
    prepared.set(part, { registry: next, transaction, inverse })
  }
  return prepared
}
