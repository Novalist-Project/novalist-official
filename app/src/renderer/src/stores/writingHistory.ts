import { WritingDocumentRegistry, sceneRefKey } from './writingDocuments'
import type { HistoryInverse, HistoryResult, SceneRef, WritingHistory, WritingTransaction } from '../views/editor/writingTypes'
import type { SharedWritingHistory } from '../collaboration/SharedWritingHistory'
import type { SharedSceneSession } from '../collaboration/SharedSceneSession'
import { reserveWritingBatch, scheduleWritingSave } from './writingPersistence'
import { retainSharedWritingSelection } from '../collaboration/sharedWritingSelection'

interface HistoryPart {
  registry: WritingDocumentRegistry
  transaction: WritingTransaction
  inverse: Extract<HistoryInverse, { kind: 'local' }>
}

interface HistoryEntry {
  parts: HistoryPart[]
  shared?: { history: SharedWritingHistory; id: string }
}
export interface WritingBatchEntry { registry: WritingDocumentRegistry; transaction: WritingTransaction }

function invert(transaction: WritingTransaction): HistoryPart['inverse'] {
  return {
    kind: 'local',
    changes: transaction.changes.map(change => ({ ...change, beforeHtml: change.afterHtml,
      afterHtml: change.beforeHtml, expectedRevision: change.expectedRevision + 1 })),
    annotationChanges: transaction.annotationChanges.map(change => ({ ...change, before: change.after, after: change.before }))
  }
}

class SessionWritingHistory implements WritingHistory {
  private readonly past: HistoryEntry[] = []
  private readonly future: HistoryEntry[] = []
  private readonly revisions = new WeakMap<WritingDocumentRegistry, Map<string, number>>()

  constructor(private readonly registry: WritingDocumentRegistry) {}

  record(transaction: WritingTransaction, inverse: HistoryInverse): void {
    if (inverse.kind !== 'local') throw new Error('This history entry requires its shared or structural history owner.')
    this.recordParts([{ registry: this.registry, transaction, inverse }])
  }

  recordParts(parts: HistoryPart[], shared?: HistoryEntry['shared']): void {
    if (!shared && !parts.some(part => part.transaction.changes.length || part.transaction.annotationChanges.length)) return
    const retained = parts.map(part => ({ registry: part.registry, transaction: structuredClone(part.transaction), inverse: structuredClone(part.inverse) }))
    for (const part of retained) this.rememberRevisions(part)
    this.past.push({ parts: retained, shared })
    for (const entry of this.future) entry.shared?.history.discard(entry.shared.id)
    this.future.length = 0
  }

  private affected(part: HistoryPart): SceneRef[] {
    return [...part.transaction.changes, ...part.transaction.annotationChanges].map(change => change.ref)
  }

  private rememberRevisions(part: HistoryPart): void {
    const revisions = this.revisions.get(part.registry) ?? new Map<string, number>()
    for (const ref of this.affected(part)) {
      const snapshot = part.registry.getSnapshot(ref)
      if (!snapshot) throw new Error('The history document is unavailable.')
      revisions.set(sceneRefKey(ref), snapshot.revision)
    }
    this.revisions.set(part.registry, revisions)
  }

  private prepare(part: HistoryPart, redo: boolean): WritingBatchEntry {
    const source = redo ? part.transaction : part.inverse
    for (const ref of this.affected(part)) {
      const snapshot = part.registry.getSnapshot(ref)
      if (!snapshot || snapshot.revision !== this.revisions.get(part.registry)?.get(sceneRefKey(ref))) {
        throw new Error('The history document changed outside this writing session.')
      }
    }
    return { registry: part.registry, transaction: {
      ...part.transaction, id: crypto.randomUUID(), origin: redo ? 'writing-redo' : 'writing-undo',
      changes: source.changes.map(change => {
        const snapshot = part.registry.getSnapshot(change.ref)!
        return { ...change, expectedRevision: snapshot.revision, expectedHash: snapshot.hash }
      }),
      annotationChanges: structuredClone(source.annotationChanges),
      beforeSelection: redo ? part.transaction.beforeSelection : part.transaction.afterSelection,
      afterSelection: redo ? part.transaction.afterSelection : part.transaction.beforeSelection
    } }
  }

  private async change(redo: boolean): Promise<HistoryResult> {
    const source = redo ? this.future : this.past
    const target = redo ? this.past : this.future
    const entry = source.at(-1)
    if (!entry) return { status: 'blocked', reason: 'writing.historyEmpty' }
    try {
      entry.shared?.history.capturePending(entry.shared.id)
      if (source.at(-1) !== entry) return this.change(redo)
      const batch = entry.parts.map(part => this.prepare(part, redo))
      for (const part of batch) part.registry.validate(part.transaction)
      if (batch.length > 1) reserveWritingBatch(batch.map(part => part.registry))
      let sharedResult: HistoryResult | undefined
      if (entry.shared) {
        const result = redo ? entry.shared.history.redoNow(entry.shared.id) : entry.shared.history.undoNow(entry.shared.id)
        if (result.status === 'blocked') return result
        sharedResult = result
      }
      WritingDocumentRegistry.applyBatch(batch)
      for (const part of entry.parts) this.rememberRevisions(part)
      for (const part of entry.parts) scheduleWritingSave(part.registry)
      source.pop()
      target.push(entry)
      if (sharedResult) return sharedResult
      const transaction = entry.parts[0].transaction
      return { status: 'applied', selection: structuredClone(redo ? transaction.afterSelection : transaction.beforeSelection) }
    } catch {
      return { status: 'blocked', reason: 'writing.historyConflict' }
    }
  }

  async undo(): Promise<HistoryResult> { return this.change(false) }
  async redo(): Promise<HistoryResult> { return this.change(true) }
}

const histories = new WeakMap<WritingDocumentRegistry, SessionWritingHistory>()

export function getWritingHistory(registry: WritingDocumentRegistry): WritingHistory {
  let history = histories.get(registry)
  if (!history) { history = new SessionWritingHistory(registry); histories.set(registry, history) }
  return history
}

export function acceptWritingTransaction(registry: WritingDocumentRegistry, transaction: WritingTransaction): void {
  acceptWritingBatch(registry, [{ registry, transaction }])
}

/** Retains every participating registry so a project replacement remains one undo. */
export function acceptWritingBatch(owner: WritingDocumentRegistry, entries: WritingBatchEntry[]): void {
  const parts = entries.map(entry => ({ ...entry, transaction: structuredClone(entry.transaction), inverse: structuredClone(invert(entry.transaction)) }))
  for (const part of parts) part.registry.validate(part.transaction)
  if (parts.length > 1) reserveWritingBatch(parts.map(part => part.registry))
  WritingDocumentRegistry.applyBatch(parts)
  getWritingHistory(owner)
  histories.get(owner)!.recordParts(parts)
  for (const part of parts) scheduleWritingSave(part.registry)
}

export function acceptSharedWritingTransaction(registry: WritingDocumentRegistry, transaction: WritingTransaction,
  history: SharedWritingHistory, sessions: ReadonlyMap<string, SharedSceneSession>): void {
  const local: WritingTransaction = { ...transaction,
    changes: transaction.changes.filter(change => !sessions.has(change.ref.sceneId)),
    annotationChanges: transaction.annotationChanges.filter(change => !sessions.has(change.ref.sceneId)) }
  if (transaction.annotationChanges.some(change => sessions.has(change.ref.sceneId))) {
    throw new Error('Shared annotations require their collaborative metadata channel.')
  }
  registry.validate(local)
  const affected = transaction.changes.filter(change => sessions.has(change.ref.sceneId))
  const prepared = affected.map(change => {
    const session = sessions.get(change.ref.sceneId)!
    session.assertReady()
    if (session.revision !== change.expectedRevision || session.html !== change.beforeHtml) {
      throw new Error('The shared writing document changed before its transaction was accepted.')
    }
    return { sceneId: change.ref.sceneId, session, apply: session.prepareChange(change.afterHtml) }
  })
  const beforeSelection = retainSharedWritingSelection(transaction.beforeSelection, sessions)
  history.begin(transaction.id, transaction.origin)
  for (const change of prepared) history.capture(change.sceneId, change)
  history.commit(transaction.id)
  history.setSelections(transaction.id, beforeSelection, retainSharedWritingSelection(transaction.afterSelection, sessions))
  registry.apply(local)
  getWritingHistory(registry)
  histories.get(registry)!.recordParts([{ registry, transaction: local, inverse: invert(local) }], { history, id: transaction.id })
  if (local.changes.length || local.annotationChanges.length) scheduleWritingSave(registry)
}
