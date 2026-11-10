import { WritingCommitError, WritingDocumentRegistry, sceneRefKey, createWritingRpcTransport } from './writingDocuments'
import type { WritingCommitRequest, WritingCommitResult, WritingTransaction } from '../views/editor/writingTypes'

type CommitTransport = (request: WritingCommitRequest) => Promise<WritingCommitResult>

export interface WritingPersistenceStatus {
  pending: boolean
  saving: boolean
  error: Exclude<WritingCommitResult, { status: 'committed' }> | 'writing.saveFailed' | null
}
interface Autosave {
  timer?: ReturnType<typeof setTimeout>
  status: WritingPersistenceStatus
  listeners: Set<(status: WritingPersistenceStatus) => void>
}
const autosaves = new WeakMap<WritingDocumentRegistry, Autosave>()

function autosaveFor(registry: WritingDocumentRegistry): Autosave {
  let autosave = autosaves.get(registry)
  if (!autosave) {
    autosave = { status: { pending: false, saving: false, error: null }, listeners: new Set() }
    autosaves.set(registry, autosave)
  }
  return autosave
}

function publishAutosave(autosave: Autosave, status: WritingPersistenceStatus): void {
  autosave.status = status
  for (const listener of autosave.listeners) {
    try { listener({ ...status }) }
    catch (error) {
      if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
      else queueMicrotask(() => { throw error })
    }
  }
}

export function observeWritingPersistence(registry: WritingDocumentRegistry, listener: (status: WritingPersistenceStatus) => void): () => void {
  const autosave = autosaveFor(registry)
  autosave.listeners.add(listener)
  listener({ ...autosave.status })
  return () => { autosave.listeners.delete(listener) }
}

export function scheduleWritingSave(registry: WritingDocumentRegistry, delay = 2000): void {
  const autosave = autosaveFor(registry)
  clearTimeout(autosave.timer)
  if (!autosave.status.pending) publishAutosave(autosave, { ...autosave.status, pending: true })
  autosave.timer = setTimeout(() => {
    autosave.timer = undefined
    if (registry.isClosed) return
    publishAutosave(autosave, { pending: true, saving: true, error: null })
    void registry.flush().then(() => {
      publishAutosave(autosave, { pending: registry.isDirty, saving: false, error: null })
    }, error => {
      publishAutosave(autosave, { pending: true, saving: false,
        error: error instanceof WritingCommitError ? error.result : 'writing.saveFailed' })
    })
  }, delay)
}

export function createWritingPersistence(transport: CommitTransport) {
  let pending: WritingCommitRequest | null = null
  let inFlight: Promise<WritingCommitResult> | null = null

  const send = async (request: WritingCommitRequest): Promise<WritingCommitResult> => {
    const result = await transport(structuredClone(request))
    if (result.status === 'committed') {
      const hashes = new Set(result.hashes.map(entry => sceneRefKey(entry.ref)))
      if ([...request.changes, ...request.annotationChanges].some(change => !hashes.has(sceneRefKey(change.ref)))) {
        throw new Error('Writing commit acknowledgement is incomplete.')
      }
      pending = null
    }
    return result
  }

  return {
    get pendingTransactionId(): string | null { return pending?.transactionId ?? null },
    commit(transaction: WritingTransaction): Promise<WritingCommitResult> {
      const request: WritingCommitRequest = { transactionId: transaction.id,
        expectedEpoch: transaction.context.workspaceEpoch, changes: transaction.changes,
        annotationChanges: transaction.annotationChanges }
      if (pending && JSON.stringify(pending) !== JSON.stringify(request)) {
        return Promise.reject(new Error('Resolve the pending writing transaction before committing another change.'))
      }
      if (inFlight) return inFlight
      pending = structuredClone(request)
      const writing = send(pending)
      inFlight = writing
      void writing.then(() => { inFlight = null }, () => { inFlight = null })
      return writing
    }
  }
}

const persistences = new Map<string, ReturnType<typeof createWritingPersistence>>()

export async function commitWritingTransaction(transaction: WritingTransaction): Promise<WritingCommitResult> {
  const key = JSON.stringify([transaction.context.workspaceId, transaction.context.workspaceEpoch, transaction.id])
  let persistence = persistences.get(key)
  if (!persistence) {
    persistence = createWritingPersistence(createWritingRpcTransport().commit)
    persistences.set(key, persistence)
  }
  const result = await persistence.commit(transaction)
  if (result.status === 'committed') persistences.delete(key)
  return result
}

const reservations = new WeakMap<WritingDocumentRegistry, CompoundWritingCommit>()

class CompoundWritingCommit {
  private readonly releases = new Map<WritingDocumentRegistry, () => void>()
  private pending: { request: WritingCommitRequest; parts: Map<WritingDocumentRegistry, WritingCommitRequest> } | null = null
  private inFlight: Promise<void> | null = null

  constructor(private readonly transport: CommitTransport) {}

  add(registries: readonly WritingDocumentRegistry[]): void {
    if (this.inFlight && registries.some(registry => !this.releases.has(registry))) {
      throw new Error('Wait for the compound writing commit before adding another book.')
    }
    const added: WritingDocumentRegistry[] = []
    try {
      for (const registry of registries) {
        if (this.releases.has(registry)) continue
        this.releases.set(registry, registry.reserveCommit(this))
        reservations.set(registry, this)
        added.push(registry)
      }
    } catch (error) {
      for (const registry of added) this.release(registry)
      throw error
    }
  }

  private release(registry: WritingDocumentRegistry): void {
    this.releases.get(registry)?.()
    this.releases.delete(registry)
    reservations.delete(registry)
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const writing = this.write()
    this.inFlight = writing
    void writing.then(() => { this.inFlight = null }, () => { this.inFlight = null })
    return writing
  }

  private prepare(): NonNullable<CompoundWritingCommit['pending']> {
    const id = crypto.randomUUID()
    const parts = new Map([...this.releases.keys()].map(registry => [registry, registry.prepareCommit(id)]))
    const requests = [...parts.values()]
    return { parts, request: { transactionId: id, expectedEpoch: requests[0].expectedEpoch,
      changes: requests.flatMap(request => request.changes), annotationChanges: requests.flatMap(request => request.annotationChanges) } }
  }

  private async write(): Promise<void> {
    await Promise.all([...this.releases.keys()].map(registry => registry.waitForCommit()))
    while (this.releases.size) {
      const pending = this.pending ?? this.prepare()
      if (!pending.request.changes.length && !pending.request.annotationChanges.length) {
        for (const registry of this.releases.keys()) this.release(registry)
        return
      }
      this.pending = pending
      const result = await this.transport(structuredClone(pending.request))
      if (result.status !== 'committed') throw new WritingCommitError(result)
      const hashes = new Set(result.hashes.map(entry => sceneRefKey(entry.ref)))
      if ([...pending.request.changes, ...pending.request.annotationChanges].some(change => !hashes.has(sceneRefKey(change.ref)))) {
        throw new Error('Writing commit acknowledgement is incomplete.')
      }
      for (const [registry, request] of pending.parts) {
        for (const change of [...request.changes, ...request.annotationChanges]) registry.getSnapshot(change.ref)
      }
      for (const [registry, request] of pending.parts) registry.acknowledgeCommit(request, result)
      this.pending = null
    }
  }
}

export function reserveWritingBatch(registries: readonly WritingDocumentRegistry[],
  transport: CommitTransport = createWritingRpcTransport().commit): void {
  if (!registries.length) return
  const context = registries[0].context
  if (registries.some(registry => registry.context.workspaceId !== context.workspaceId || registry.context.workspaceEpoch !== context.workspaceEpoch)) {
    throw new Error('A compound writing commit must belong to one workspace epoch.')
  }
  const owners = new Set(registries.map(registry => reservations.get(registry)).filter(owner => owner !== undefined))
  if (owners.size > 1) throw new Error('Wait for earlier compound writing commits before combining their books.')
  const owner = owners.values().next().value ?? new CompoundWritingCommit(transport)
  owner.add(registries)
}
