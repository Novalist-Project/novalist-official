import { registerPendingWrite } from '../stores/pendingWrites'
import { sceneRefKey, createWritingRpcTransport, type WritingDocumentRegistry } from '../stores/writingDocuments'
import type { WritingHistoryRebase } from '../stores/writingHistoryRebase'
import type { AnnotationChange, SceneRef, WritingAnnotations } from '../views/editor/writingTypes'
import { mergeSharedAnnotations } from './sharedAnnotationMerge'
export { mergeSharedAnnotations } from './sharedAnnotationMerge'

export interface SharedAnnotationRequest { transactionId: string; expectedEpoch: number; changes: AnnotationChange[] }
export type SharedAnnotationResult =
  | { status: 'committed'; operationId: string; annotations: { ref: SceneRef; annotations: WritingAnnotations }[] }
  | { status: 'conflict'; conflicts: SceneRef[] }
  | { status: 'retryable'; operationId: string; errorCode: string }
export interface SharedAnnotationPart { registry: WritingDocumentRegistry; change: AnnotationChange }
export interface SharedAnnotationHistory {
  refs(): SceneRef[]
  validate(redo: boolean): void
  undo(): void
  redo(): void
  rebind(previous: WritingDocumentRegistry, next: WritingDocumentRegistry, changes: readonly WritingHistoryRebase[]): void
}
type Commit = (request: SharedAnnotationRequest) => Promise<SharedAnnotationResult>
interface Pending { request: SharedAnnotationRequest; parts: SharedAnnotationPart[] }

export class SharedWritingAnnotations {
  private readonly pending: Pending[] = []
  private readonly pendingScenes = new Map<string, number>()
  private readonly unregister: () => void
  private readonly listeners = new Set<(error: Error | null) => void>()
  private inFlight: Promise<void> | null = null
  private failure: Error | null = null
  private readonly revisions = new Map<string, number>()
  private readonly refreshes = new Map<string, number>()

  constructor(private readonly commit: Commit, private readonly autoFlush = false) {
    this.unregister = registerPendingWrite(() => this.flush())
  }

  get pendingTransactionId(): string | null { return this.pending[0]?.request.transactionId ?? null }
  isSceneDirty(ref: SceneRef): boolean { return this.pendingScenes.has(sceneRefKey(ref)) }
  revision(ref: SceneRef): number { return this.revisions.get(sceneRefKey(ref)) ?? 0 }
  observe(listener: (error: Error | null) => void): () => void {
    this.listeners.add(listener)
    listener(this.failure)
    return () => { this.listeners.delete(listener) }
  }

  validate(parts: readonly SharedAnnotationPart[]): void {
    const seen = new Set<string>()
    for (const { registry, change } of parts) {
      const key = sceneRefKey(change.ref)
      if (seen.has(key)) throw new Error('Duplicate scene annotation change.')
      seen.add(key)
      if (!registry.getSnapshot(change.ref)?.shared) throw new Error('The annotation transaction requires a shared scene.')
      const current = registry.getAnnotations(change.ref)
      if (!current) throw new Error('Shared annotations are unavailable.')
      mergeSharedAnnotations(current, change)
    }
  }

  accept(id: string, parts: readonly SharedAnnotationPart[]): SharedAnnotationHistory {
    if (!parts.length) throw new Error('Shared annotation transaction is empty.')
    const retained = parts.map(part => ({ registry: part.registry, change: structuredClone(part.change) }))
    this.enqueue(id, retained)
    const inverse = (): SharedAnnotationPart[] => retained.map(part => ({ registry: part.registry,
      change: { ref: part.change.ref, before: part.change.after, after: part.change.before } }))
    return {
      refs: () => retained.map(part => ({ ...part.change.ref })),
      validate: redo => this.validate(redo ? retained : inverse()),
      undo: () => this.enqueue(crypto.randomUUID(), inverse()),
      redo: () => this.enqueue(crypto.randomUUID(), retained),
      rebind: (previous, next, changes) => {
        const refs = new Map(changes.map(change => [sceneRefKey(change.before), change.after]))
        for (const part of retained) if (part.registry === previous) {
          part.registry = next
          part.change.ref = refs.get(sceneRefKey(part.change.ref)) ?? part.change.ref
        }
      }
    }
  }

  private enqueue(id: string, parts: readonly SharedAnnotationPart[]): void {
    this.validate(parts)
    const context = parts[0].registry.context
    if (parts.some(part => part.registry.context.workspaceId !== context.workspaceId || part.registry.context.workspaceEpoch !== context.workspaceEpoch)) throw new Error('Shared annotation changes require one workspace epoch.')
    if (this.pending.some(pending => pending.request.expectedEpoch !== context.workspaceEpoch)) throw new Error('Flush shared annotations before replacing the workspace epoch.')
    const retained = parts.map(part => ({ registry: part.registry, change: structuredClone(part.change) }))
    this.pending.push({ request: { transactionId: id, expectedEpoch: context.workspaceEpoch, changes: retained.map(part => part.change) }, parts: retained })
    for (const { change } of retained) {
      const key = sceneRefKey(change.ref)
      this.pendingScenes.set(key, (this.pendingScenes.get(key) ?? 0) + 1)
    }
    for (const { registry, change } of retained) this.publish(registry, change.ref, mergeSharedAnnotations(registry.getAnnotations(change.ref)!, change))
    if (this.autoFlush) void this.flush().catch(error => this.publishFailure(error))
  }

  receive(registry: WritingDocumentRegistry, ref: SceneRef, annotations: WritingAnnotations): void {
    let current = structuredClone(annotations)
    for (const pending of this.pending) for (const part of pending.parts) {
      if (sceneRefKey(part.change.ref) === sceneRefKey(ref)) current = mergeSharedAnnotations(current, part.change)
    }
    this.publish(registry, ref, current)
  }

  async refresh(registry: WritingDocumentRegistry, ref: SceneRef, read: () => Promise<WritingAnnotations | undefined>): Promise<void> {
    const key = sceneRefKey(ref)
    const hasPending = (): boolean => this.pending.some(pending => pending.parts.some(part => sceneRefKey(part.change.ref) === key))
    if (hasPending()) return
    registry.getSnapshot(ref)
    const generation = (this.refreshes.get(key) ?? 0) + 1
    this.refreshes.set(key, generation)
    const revision = this.revision(ref)
    const annotations = await read()
    if (annotations && generation === this.refreshes.get(key) && revision === this.revision(ref) && !hasPending()) this.receive(registry, ref, annotations)
  }

  private publish(registry: WritingDocumentRegistry, ref: SceneRef, annotations: WritingAnnotations): void {
    this.revisions.set(sceneRefKey(ref), this.revision(ref) + 1)
    registry.receiveSharedAnnotations(ref, annotations)
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const operation = this.write()
    this.inFlight = operation
    void operation.then(() => { this.inFlight = null }, () => { this.inFlight = null })
    return operation
  }

  async rebaseRecovery(epoch: number): Promise<void> {
    if (this.inFlight) await Promise.allSettled([this.inFlight])
    if (!Number.isSafeInteger(epoch) || epoch < 0 || this.pending.some(pending => pending.parts.some(part => part.registry.context.workspaceEpoch !== epoch))) {
      throw new Error('Recover annotation owners before replacing their workspace epoch.')
    }
    for (const pending of this.pending) pending.request = { ...pending.request, expectedEpoch: epoch }
  }

  private async write(): Promise<void> {
    try {
      while (this.pending.length) {
        const pending = this.pending[0]
        for (const part of pending.parts) part.registry.getSnapshot(part.change.ref)
        const result = await this.commit(structuredClone(pending.request))
        if (result.status !== 'committed') throw new Error(result.status === 'conflict' ? 'writing.annotationConflict' : result.errorCode)
        const annotations = new Map(result.annotations.map(value => [sceneRefKey(value.ref), value.annotations]))
        for (const part of pending.parts) {
          part.registry.getSnapshot(part.change.ref)
          if (!annotations.has(sceneRefKey(part.change.ref))) throw new Error('Shared annotation acknowledgement is incomplete.')
        }
        this.pending.shift()
        for (const { change } of pending.parts) {
          const key = sceneRefKey(change.ref), remaining = (this.pendingScenes.get(key) ?? 1) - 1
          if (remaining) this.pendingScenes.set(key, remaining)
          else this.pendingScenes.delete(key)
        }
        for (const part of pending.parts) this.receive(part.registry, part.change.ref, annotations.get(sceneRefKey(part.change.ref))!)
      }
      this.publishFailure(null)
    } catch (error) { this.publishFailure(error); throw error }
  }

  private publishFailure(error: unknown): void {
    this.failure = error === null ? null : error instanceof Error ? error : new Error('writing.annotationSaveFailed')
    for (const listener of this.listeners) {
      try { listener(this.failure) }
      catch (failure) {
        if (typeof globalThis.reportError === 'function') globalThis.reportError(failure)
        else queueMicrotask(() => { throw failure })
      }
    }
  }

  async prepareClose(): Promise<() => void> {
    await this.flush()
    return () => { this.unregister(); this.listeners.clear() }
  }

  async close(): Promise<void> { (await this.prepareClose())() }
}

const owners = new Map<string, SharedWritingAnnotations>()

export function findSharedWritingAnnotations(registry: WritingDocumentRegistry): SharedWritingAnnotations | undefined {
  return owners.get(registry.context.workspaceId)
}

export async function rebaseSharedWritingAnnotations(workspaceId: string, epoch: number): Promise<void> {
  await owners.get(workspaceId)?.rebaseRecovery(epoch)
}

export function getSharedWritingAnnotations(registry: WritingDocumentRegistry): SharedWritingAnnotations {
  const key = registry.context.workspaceId
  let owner = owners.get(key)
  if (!owner) {
    owner = new SharedWritingAnnotations(async request => {
      const { rpc } = await import('../rpc/client')
      return rpc.request<SharedAnnotationResult>('writing/commitSharedAnnotations', [request])
    }, true)
    owners.set(key, owner)
  }
  return owner
}

export async function refreshSharedWritingAnnotations(registry: WritingDocumentRegistry, refs: readonly SceneRef[]): Promise<void> {
  const owner = getSharedWritingAnnotations(registry)
  const transport = createWritingRpcTransport()
  await Promise.all(refs.map(ref => owner.refresh(registry, ref, async () => (await transport.read(ref)).annotations)))
}

export async function closeSharedWritingAnnotations(workspaceId: string): Promise<void> {
  (await prepareSharedWritingAnnotationsClose(workspaceId))()
}

export async function prepareSharedWritingAnnotationsClose(workspaceId: string): Promise<() => void> {
  const owner = owners.get(workspaceId)
  if (!owner) return () => undefined
  const dispose = await owner.prepareClose()
  return () => {
    dispose()
    if (owners.get(workspaceId) === owner) owners.delete(workspaceId)
  }
}
