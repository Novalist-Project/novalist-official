import { WritingDocumentRegistry, sceneRefKey } from './writingDocuments'
import type { HistoryInverse, HistoryResult, SceneRef, WritingHistory, WritingTransaction } from '../views/editor/writingTypes'
import type { SharedWritingHistory } from '../collaboration/SharedWritingHistory'
import type { SharedSceneSession } from '../collaboration/SharedSceneSession'
import { reserveWritingBatch, scheduleWritingSave } from './writingPersistence'
import { prepareHistoryRebase, type WritingHistoryRebase, type WritingHistoryPart as HistoryPart } from './writingHistoryRebase'
import { applySharedWritingBatch, inverseWritingTransaction as invert, type SharedBatchOptions } from './writingSharedTransactions'
import type { SharedAnnotationHistory } from '../collaboration/sharedWritingAnnotations'

interface HistoryEntry {
  parts: HistoryPart[]
  shared?: { history: SharedWritingHistory; id: string; refs?: SceneRef[] }
  external?: WritingExternalHistory
  annotations?: SharedAnnotationHistory
}
export interface WritingBatchEntry { registry: WritingDocumentRegistry; transaction: WritingTransaction }
export interface WritingExternalHistory {
  undo(): Promise<HistoryResult>
  redo(): Promise<HistoryResult>
  refs?: readonly SceneRef[]
  dispose?(): void
}

class SessionWritingHistory implements WritingHistory {
  private readonly past: HistoryEntry[] = []
  private readonly future: HistoryEntry[] = []
  private readonly revisions = new WeakMap<WritingDocumentRegistry, Map<string, number>>()
  private queue: Promise<void> = Promise.resolve()
  private externalPending = false
  private disposed = false

  constructor(private registry: WritingDocumentRegistry) {}

  get isDisposed(): boolean { return this.disposed }
  get workspaceId(): string { return this.registry.context.workspaceId }
  assertAvailable(): void {
    if (this.disposed || this.externalPending) throw new Error('Writing history is closed or applying an external operation.')
  }
  involves(registry: WritingDocumentRegistry): boolean {
    return this.registry === registry || [...this.past, ...this.future].some(entry =>
      entry.parts.some(part => part.registry === registry) ||
      [...entry.external?.refs ?? [], ...entry.shared?.refs ?? [], ...entry.annotations?.refs() ?? []]
        .some(ref => this.workspaceId === registry.context.workspaceId && ref.bookId === registry.context.bookId && ref.draftId === registry.context.draftId))
  }
  dispose(): void {
    this.prepareDispose()()
  }

  prepareDispose(): () => void {
    this.assertAvailable()
    return () => {
      if (this.disposed) return
      for (const entry of [...this.past, ...this.future]) { entry.shared?.history.discard(entry.shared.id); entry.external?.dispose?.() }
      this.past.length = 0
      this.future.length = 0
      this.disposed = true
      activeHistories.delete(this)
    }
  }

  record(transaction: WritingTransaction, inverse: HistoryInverse): void {
    if (inverse.kind !== 'local') throw new Error('This history entry requires its shared or structural history owner.')
    this.recordParts([{ registry: this.registry, transaction, inverse }])
  }

  recordParts(parts: HistoryPart[], shared?: HistoryEntry['shared'], annotations?: SharedAnnotationHistory): void {
    this.assertAvailable()
    if (!shared && !annotations && !parts.some(part => part.transaction.changes.length || part.transaction.annotationChanges.length)) return
    const retained = parts.map(part => ({ registry: part.registry, transaction: structuredClone(part.transaction), inverse: structuredClone(part.inverse) }))
    for (const part of retained) this.rememberRevisions(part)
    this.past.push({ parts: retained, shared, annotations })
    for (const entry of this.future) { entry.shared?.history.discard(entry.shared.id); entry.external?.dispose?.() }
    this.future.length = 0
  }

  recordExternal(external: WritingExternalHistory): void {
    this.assertAvailable()
    for (const entry of this.future) { entry.shared?.history.discard(entry.shared.id); entry.external?.dispose?.() }
    this.future.length = 0
    this.past.push({ parts: [], external })
  }

  prepareRebind(previous: WritingDocumentRegistry, next: WritingDocumentRegistry, changes: readonly WritingHistoryRebase[]): () => void {
    const entries = [...this.past, ...this.future]
    const prepared = prepareHistoryRebase(entries.flatMap(entry => entry.parts), previous, next, changes)
    const refs = new Map(changes.map(change => [sceneRefKey(change.before), change.after]))
    const revisions = new Map<string, number>()
    for (const part of prepared.values()) for (const ref of this.affected(part)) {
      const snapshot = next.getSnapshot(ref)
      if (snapshot) revisions.set(sceneRefKey(ref), snapshot.revision)
    }
    return () => {
      for (const entry of entries) {
        entry.parts = entry.parts.map(part => prepared.get(part) ?? part)
        entry.annotations?.rebind(previous, next, changes)
        if (entry.shared?.refs) entry.shared.refs = entry.shared.refs.map(ref => refs.get(sceneRefKey(ref)) ?? ref)
        if (entry.external?.refs) entry.external.refs = entry.external.refs.map(ref => refs.get(sceneRefKey(ref)) ?? ref)
      }
      if (this.registry === previous) this.registry = next
      this.revisions.set(next, revisions)
    }
  }

  references(): SceneRef[] {
    const refs = [...this.past, ...this.future].flatMap(entry => [...entry.parts.flatMap(part => this.affected(part)),
      ...entry.external?.refs ?? [], ...entry.shared?.refs ?? [], ...entry.annotations?.refs() ?? []])
    return [...new Map(refs.map(ref => [sceneRefKey(ref), { ...ref }])).values()]
  }

  private refreshRevisions(refs: readonly SceneRef[]): void {
    const affected = new Set(refs.map(sceneRefKey))
    for (const entry of [...this.past, ...this.future]) for (const part of entry.parts) {
      const revisions = this.revisions.get(part.registry)
      for (const ref of this.affected(part)) {
        if (!affected.has(sceneRefKey(ref))) continue
        const snapshot = part.registry.getSnapshot(ref)
        if (snapshot) revisions?.set(sceneRefKey(ref), snapshot.revision)
      }
    }
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
    if (this.disposed) return { status: 'blocked', reason: 'writing.historyClosed' }
    const source = redo ? this.future : this.past
    const target = redo ? this.past : this.future
    const entry = source.at(-1)
    if (!entry) return { status: 'blocked', reason: 'writing.historyEmpty' }
    try {
      if (entry.external) {
        this.externalPending = true
        const result = await (redo ? entry.external.redo() : entry.external.undo())
        if (result.status === 'applied') {
          this.refreshRevisions(entry.external.refs ?? [])
          source.pop()
          target.push(entry)
        }
        return result
      }
      entry.shared?.history.capturePending(entry.shared.id)
      if (source.at(-1) !== entry) return this.change(redo)
      const batch = entry.parts.map(part => this.prepare(part, redo))
      for (const part of batch) part.registry.validate(part.transaction)
      entry.annotations?.validate(redo)
      if (batch.length > 1) reserveWritingBatch(batch.map(part => part.registry))
      if (entry.annotations) {
        if (redo) entry.annotations.redo()
        else entry.annotations.undo()
      }
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
    } finally { this.externalPending = false }
  }

  private enqueue(redo: boolean): Promise<HistoryResult> {
    const operation = this.queue.then(() => this.change(redo))
    this.queue = operation.then(() => {})
    return operation
  }
  undo(): Promise<HistoryResult> { return this.enqueue(false) }
  redo(): Promise<HistoryResult> { return this.enqueue(true) }
}

const histories = new WeakMap<WritingDocumentRegistry, SessionWritingHistory>()
const activeHistories = new Set<SessionWritingHistory>()

export function getWritingHistory(registry: WritingDocumentRegistry): WritingHistory {
  let history = histories.get(registry)
  if (!history || history.isDisposed) {
    history = new SessionWritingHistory(registry)
    histories.set(registry, history)
    activeHistories.add(history)
  }
  return history
}

export function acceptWritingTransaction(registry: WritingDocumentRegistry, transaction: WritingTransaction): void {
  acceptWritingBatch(registry, [{ registry, transaction }])
}

/** Retains every participating registry so a project replacement remains one undo. */
export function acceptWritingBatch(owner: WritingDocumentRegistry, entries: WritingBatchEntry[]): void {
  getWritingHistory(owner)
  histories.get(owner)!.assertAvailable()
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
  const owners = new Map<string, SharedSceneSession>()
  for (const change of [...transaction.changes, ...transaction.annotationChanges]) {
    const session = sessions.get(change.ref.sceneId)
    if (session) owners.set(sceneRefKey(change.ref), session)
  }
  acceptSharedWritingBatch(registry, [{ registry, transaction }], history, owners, { selectionSessions: sessions })
}

export function acceptSharedWritingBatch(owner: WritingDocumentRegistry, entries: readonly WritingBatchEntry[],
  history: SharedWritingHistory, sessions: ReadonlyMap<string, SharedSceneSession>, options: SharedBatchOptions = {}): void {
  getWritingHistory(owner)
  histories.get(owner)!.assertAvailable()
  const accepted = applySharedWritingBatch(owner, entries, history, sessions, options)
  histories.get(owner)!.recordParts(accepted.parts, accepted.shared, accepted.annotations)
  for (const part of accepted.parts) if (part.transaction.changes.length || part.transaction.annotationChanges.length) scheduleWritingSave(part.registry)
}

export function recordExternalWritingTransaction(registry: WritingDocumentRegistry, transaction: WritingTransaction,
  external: WritingExternalHistory): void {
  registry.validate({ ...transaction, changes: [], annotationChanges: [] })
  getWritingHistory(registry)
  histories.get(registry)!.recordExternal(external)
}

export function getWritingHistoryReferences(registry: WritingDocumentRegistry): SceneRef[] {
  getWritingHistory(registry)
  return histories.get(registry)!.references()
}

export function rebindWritingHistory(previous: WritingDocumentRegistry, next: WritingDocumentRegistry,
  changes: readonly WritingHistoryRebase[] = []): void {
  getWritingHistory(previous)
  const history = histories.get(previous)!
  if (histories.has(next) && histories.get(next) !== history) throw new Error('The replacement registry already owns another writing history.')
  const rebases = [...activeHistories].filter(candidate => candidate.involves(previous)).map(candidate => candidate.prepareRebind(previous, next, changes))
  for (const rebase of rebases) rebase()
  histories.set(next, history)
}

export function disposeWritingHistory(registry: WritingDocumentRegistry): void {
  const history = histories.get(registry)
  if (history && !history.isDisposed) history.dispose()
  histories.delete(registry)
}

export function disposeWritingHistories(workspaceId: string): void {
  prepareWritingHistoriesClose(workspaceId)()
}

export function prepareWritingHistoriesClose(workspaceId: string): () => void {
  const disposals = [...activeHistories].filter(history => history.workspaceId === workspaceId).map(history => history.prepareDispose())
  return () => { for (const dispose of disposals) dispose() }
}

export function assertWritingHistoriesAvailable(workspaceId: string): void {
  for (const history of activeHistories) if (history.workspaceId === workspaceId) history.assertAvailable()
}
