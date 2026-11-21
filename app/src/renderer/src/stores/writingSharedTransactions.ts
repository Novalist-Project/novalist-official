import { WritingDocumentRegistry, sceneRefKey } from './writingDocuments'
import { reserveWritingBatch } from './writingPersistence'
import type { WritingHistoryPart } from './writingHistoryRebase'
import type { WritingBatchEntry } from './writingHistory'
import type { SharedSceneSession } from '../collaboration/SharedSceneSession'
import type { SharedWritingHistory } from '../collaboration/SharedWritingHistory'
import { retainSharedWritingSelection } from '../collaboration/sharedWritingSelection'
import { getSharedWritingAnnotations, type SharedAnnotationHistory, type SharedWritingAnnotations } from '../collaboration/sharedWritingAnnotations'
import type { SceneRef, WritingTransaction } from '../views/editor/writingTypes'

export interface SharedBatchOptions {
  annotations?: SharedWritingAnnotations
  selectionSessions?: ReadonlyMap<string, SharedSceneSession>
}
export interface AcceptedSharedBatch {
  parts: WritingHistoryPart[]
  shared: { history: SharedWritingHistory; id: string; refs: SceneRef[] }
  annotations?: SharedAnnotationHistory
}

export function inverseWritingTransaction(transaction: WritingTransaction): WritingHistoryPart['inverse'] {
  return { kind: 'local', changes: transaction.changes.map(change => ({ ...change, beforeHtml: change.afterHtml,
    afterHtml: change.beforeHtml, expectedRevision: change.expectedRevision + 1 })),
  annotationChanges: transaction.annotationChanges.map(change => ({ ...change, before: change.after, after: change.before })) }
}

export function applySharedWritingBatch(owner: WritingDocumentRegistry, entries: readonly WritingBatchEntry[],
  history: SharedWritingHistory, sessions: ReadonlyMap<string, SharedSceneSession>, options: SharedBatchOptions = {}): AcceptedSharedBatch {
  if (!entries.length) throw new Error('A shared writing batch is empty.')
  const first = entries[0].transaction
  const metadata = options.annotations ?? getSharedWritingAnnotations(owner)
  const parts: WritingHistoryPart[] = []
  const annotations = entries.flatMap(({ registry, transaction }) => transaction.annotationChanges
    .filter(change => registry.getSnapshot(change.ref)?.shared).map(change => ({ registry, change })))
  const prepared: { sceneId: string; session: SharedSceneSession; apply: ReturnType<SharedSceneSession['prepareChange']> }[] = []
  const selectionSessions = new Map(options.selectionSessions)
  const seen = new Set<string>()
  for (const { registry, transaction } of entries) {
    if (registry.context.workspaceId !== owner.context.workspaceId || registry.context.workspaceEpoch !== owner.context.workspaceEpoch) throw new Error('A shared writing batch requires one workspace epoch.')
    const local = { ...transaction, changes: transaction.changes.filter(change => !registry.getSnapshot(change.ref)?.shared),
      annotationChanges: transaction.annotationChanges.filter(change => !registry.getSnapshot(change.ref)?.shared) }
    registry.validate(local)
    parts.push({ registry, transaction: structuredClone(local), inverse: inverseWritingTransaction(local) })
    for (const change of transaction.changes) {
      const key = sceneRefKey(change.ref)
      if (seen.has(key)) throw new Error('Duplicate scene change in shared writing batch.')
      seen.add(key)
      if (!registry.getSnapshot(change.ref)?.shared) continue
      const session = sessions.get(key)
      if (!session) throw new Error('The shared writing document has no retained owner.')
      session.assertReady()
      if (session.revision !== change.expectedRevision || session.html !== change.beforeHtml) throw new Error('The shared writing document changed before its transaction was accepted.')
      prepared.push({ sceneId: key, session, apply: session.prepareChange(change.afterHtml) })
      if (change.ref.bookId === owner.context.bookId && change.ref.draftId === owner.context.draftId) selectionSessions.set(change.ref.sceneId, session)
    }
  }
  metadata.validate(annotations)
  const before = retainSharedWritingSelection(first.beforeSelection, selectionSessions)
  if (parts.length > 1) reserveWritingBatch(parts.map(part => part.registry))
  history.begin(first.id, first.origin)
  const annotationHistory = annotations.length ? metadata.accept(first.id, annotations) : undefined
  for (const change of prepared) history.capture(change.sceneId, change)
  history.commit(first.id)
  history.setSelections(first.id, before, retainSharedWritingSelection(first.afterSelection, selectionSessions))
  WritingDocumentRegistry.applyBatch(parts)
  return { parts, shared: { history, id: first.id,
    refs: entries.flatMap(({ registry, transaction }) => transaction.changes.filter(change => registry.getSnapshot(change.ref)?.shared).map(change => ({ ...change.ref }))) },
  annotations: annotationHistory }
}
