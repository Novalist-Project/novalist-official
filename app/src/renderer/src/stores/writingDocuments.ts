import { registerPendingWrite } from './pendingWrites'
import type {
  AnnotationChange, SceneChange, SceneRef, SceneSnapshot, WritingCommitRequest,
  WritingCommitResult, WritingContext, WritingRegistry, WritingTransaction, WritingAnnotations, WritingActivation
} from '../views/editor/writingTypes'

export interface WritingDocumentTransport {
  read(ref: SceneRef): Promise<Pick<SceneSnapshot, 'html' | 'hash' | 'shared'> & { annotations?: WritingAnnotations }>
  activate(ref: SceneRef, context: WritingContext, ownership: WritingActivation): Promise<boolean>
  commit(request: WritingCommitRequest): Promise<WritingCommitResult>
}

export interface WritingDocumentOptions {
  context: WritingContext
  isCurrent(context: WritingContext): boolean
  transport?: WritingDocumentTransport
}

export function sceneRefKey(ref: SceneRef): string {
  return JSON.stringify([ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId])
}

export function writingContextKey(context: WritingContext): string {
  return JSON.stringify([context.workspaceId, context.workspaceEpoch, context.bookId, context.draftId])
}

export class WritingContextError extends Error {
  constructor() { super('Writing document context is no longer current.') }
}

export class WritingCommitError extends Error {
  readonly result: Exclude<WritingCommitResult, { status: 'committed' }>
  constructor(result: Exclude<WritingCommitResult, { status: 'committed' }>) {
    super(result.status === 'retryable' ? result.errorCode : 'writing.conflict')
    this.result = result
  }
}

type Document = { current: SceneSnapshot; saved: SceneSnapshot; annotations: WritingAnnotations | null }
type Listener = (snapshot: SceneSnapshot) => void
type PreparedChange = [string, SceneChange, Document]
type WritingBatchEntry = { registry: WritingDocumentRegistry; transaction: WritingTransaction }

function sameAnnotations(a: WritingAnnotations, b: WritingAnnotations): boolean {
  return a.comments.length === b.comments.length && a.footnotes.length === b.footnotes.length &&
    a.comments.every((comment, index) => {
      const other = b.comments[index]
      return comment.id === other.id && comment.anchorText === other.anchorText &&
        comment.text === other.text && comment.resolved === other.resolved &&
        comment.createdAt === other.createdAt && comment.author === other.author &&
        comment.isTodo === other.isTodo && comment.verdict === other.verdict &&
        sameReplies(comment.replies, other.replies)
    }) && a.footnotes.every((footnote, index) => {
      const other = b.footnotes[index]
      return footnote.id === other.id && footnote.number === other.number && footnote.text === other.text
    })
}

function sameReplies(a: WritingAnnotations['comments'][number]['replies'], b: WritingAnnotations['comments'][number]['replies']): boolean {
  if (!a || !b) return a === b
  return a.length === b.length && a.every((reply, index) => {
    const other = b[index]
    return reply.id === other.id && reply.author === other.author && reply.text === other.text && reply.createdAt === other.createdAt
  })
}

/** Retains canonical HTML independently of projections and mounted editor frames. */
export class WritingDocumentRegistry implements WritingRegistry {
  readonly context: WritingContext
  private readonly transport: WritingDocumentTransport
  private readonly isCurrent: WritingDocumentOptions['isCurrent']
  private readonly documents = new Map<string, Document>()
  private readonly reads = new Map<string, Promise<SceneSnapshot>>()
  private readonly references = new Map<string, SceneRef>()
  private readonly listeners = new Map<string, Map<Listener, number>>()
  private readonly captures = new Set<() => void>()
  private readonly annotations = new Map<string, AnnotationChange>()
  private readonly unregisterPending: () => void
  private inFlight: Promise<void> | null = null
  private pendingCommit: WritingCommitRequest | null = null
  private reservation: { flush(): Promise<void> } | null = null
  private closed = false

  constructor(options: WritingDocumentOptions) {
    this.context = Object.freeze({ ...options.context })
    this.isCurrent = options.isCurrent
    this.transport = options.transport ?? createWritingRpcTransport()
    this.unregisterPending = registerPendingWrite(() => this.flush(), () => this.captureLive())
  }

  get isDirty(): boolean {
    return !!this.pendingCommit || this.annotations.size > 0 || [...this.documents.values()].some(document => document.current.html !== document.saved.html)
  }

  get isClosed(): boolean { return this.closed }

  private assertCurrent(): void {
    if (this.closed || !this.isCurrent(this.context)) throw new WritingContextError()
  }

  private validateRef(ref: SceneRef): string {
    this.assertCurrent()
    if (ref.bookId !== this.context.bookId || ref.draftId !== this.context.draftId) throw new WritingContextError()
    return sceneRefKey(ref)
  }

  async read(ref: SceneRef): Promise<SceneSnapshot> {
    const key = this.validateRef(ref)
    const existing = this.documents.get(key)
    if (existing) return existing.current
    const pending = this.reads.get(key)
    if (pending) return pending
    const reference = Object.freeze({ ...ref })
    this.references.set(key, reference)
    const read = this.load(reference, key)
    this.reads.set(key, read)
    try { return await read }
    finally { if (this.reads.get(key) === read) this.reads.delete(key) }
  }

  private async load(ref: SceneRef, key: string): Promise<SceneSnapshot> {
    const content = await this.transport.read(ref)
    this.assertCurrent()
    const shared = content.shared ? Object.freeze({ ...content.shared }) : content.shared
    const snapshot = Object.freeze({ ...ref, html: content.html, hash: content.hash, shared, revision: 0 })
    this.documents.set(key, { current: snapshot, saved: snapshot, annotations: content.annotations ? structuredClone(content.annotations) : null })
    this.notify(key, snapshot)
    return snapshot
  }

  capture(): readonly SceneSnapshot[] {
    return [...this.documents.values()].map(document => document.current)
  }

  getSnapshot(ref: SceneRef): SceneSnapshot | undefined {
    return this.documents.get(this.validateRef(ref))?.current
  }

  getAnnotations(ref: SceneRef): WritingAnnotations | null {
    const annotations = this.documents.get(this.validateRef(ref))?.annotations
    return annotations ? structuredClone(annotations) : null
  }

  registerCapture(capture: () => void): () => void {
    this.captures.add(capture)
    return () => this.captures.delete(capture)
  }

  private captureLive(): void {
    for (const capture of this.captures) capture()
  }

  apply(tx: WritingTransaction): void {
    WritingDocumentRegistry.applyBatch([{ registry: this, transaction: tx }])
  }

  validate(tx: WritingTransaction): void {
    this.assertCurrent()
    if (writingContextKey(tx.context) !== writingContextKey(this.context)) throw new WritingContextError()
    this.validateChanges(tx.changes)
    this.validateAnnotations(tx.annotationChanges)
  }

  static applyBatch(entries: readonly WritingBatchEntry[]): void {
    const owners = new Set<WritingDocumentRegistry>()
    const context = entries[0]?.registry.context
    const prepared = entries.map(({ registry, transaction }) => {
      if (owners.has(registry)) throw new Error('A writing batch must group changes by document owner.')
      owners.add(registry)
      if (registry.context.workspaceId !== context?.workspaceId || registry.context.workspaceEpoch !== context.workspaceEpoch) {
        throw new WritingContextError()
      }
      registry.validate(transaction)
      return { registry, changes: registry.validateChanges(transaction.changes),
        annotations: structuredClone(transaction.annotationChanges) }
    })
    const updates = prepared.map(({ registry, changes, annotations }) => ({
      registry, affected: registry.applyPrepared(changes, annotations)
    }))
    for (const { registry, affected } of updates) {
      for (const key of affected) registry.notify(key, registry.documents.get(key)!.current)
    }
  }

  private applyPrepared(changes: PreparedChange[], annotations: AnnotationChange[]): Set<string> {
    const affected = new Set(changes.map(([key]) => key))
    for (const [key, change, document] of changes) {
      document.current = Object.freeze({ ...document.current, html: change.afterHtml, revision: document.current.revision + 1 })
      this.documents.set(key, document)
    }
    for (const annotation of annotations) {
      const key = sceneRefKey(annotation.ref)
      const previous = this.annotations.get(key)
      this.annotations.set(key, structuredClone({ ...annotation, before: previous?.before ?? annotation.before }))
      const document = this.documents.get(key)!
      document.annotations = structuredClone(annotation.after)
      if (!affected.has(key)) document.current = Object.freeze({ ...document.current, revision: document.current.revision + 1 })
      affected.add(key)
    }
    return affected
  }

  private validateAnnotations(changes: AnnotationChange[]): void {
    const seen = new Set<string>()
    for (const change of changes) {
      const key = this.validateRef(change.ref)
      if (seen.has(key)) throw new Error('Duplicate annotation change in writing transaction.')
      seen.add(key)
      const document = this.documents.get(key)
      if (!document) throw new Error('Writing document must be loaded before annotation changes.')
      if (document.current.shared) throw new Error('Shared annotation changes require their collaborative channel.')
      if (document.annotations && !sameAnnotations(document.annotations, change.before)) {
        throw new Error('Writing annotation revision conflict.')
      }
    }
  }

  private validateChanges(changes: SceneChange[]): PreparedChange[] {
    const seen = new Set<string>()
    return changes.map(change => {
      const key = this.validateRef(change.ref)
      const document = this.documents.get(key)
      if (!document) throw new Error('Writing document must be loaded before changes.')
      if (seen.has(key)) throw new Error('Duplicate scene change in writing transaction.')
      seen.add(key)
      if (document.current.shared) throw new Error('Shared writing changes require their collaborative channel.')
      if (document.current.revision !== change.expectedRevision || document.current.html !== change.beforeHtml) {
        throw new Error('Writing document revision conflict.')
      }
      return [key, change, document]
    })
  }

  subscribe(ref: SceneRef | string, listener: Listener): () => void {
    const reference = typeof ref === 'string' ? this.resolveSceneId(ref) : ref
    const key = this.validateRef(reference)
    this.references.set(key, Object.freeze({ ...reference }))
    const listeners = this.listeners.get(key) ?? new Map<Listener, number>()
    listeners.set(listener, (listeners.get(listener) ?? 0) + 1)
    this.listeners.set(key, listeners)
    const document = this.documents.get(key)
    if (document) listener(document.current)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (listeners.get(listener) ?? 1) - 1
      if (remaining) listeners.set(listener, remaining)
      else listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(key)
    }
  }

  private resolveSceneId(sceneId: string): SceneRef {
    const refs = [...this.references.values()].filter(ref => ref.sceneId === sceneId)
    if (refs.length !== 1) throw new Error('Writing scene subscription is missing or ambiguous; use its complete reference.')
    return refs[0]
  }

  private notify(key: string, snapshot: SceneSnapshot): void {
    for (const listener of this.listeners.get(key)?.keys() ?? []) {
      try { listener(snapshot) }
      catch (error) {
        if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
        else queueMicrotask(() => { throw error })
      }
    }
  }

  async activate(ref: SceneRef, ownership: WritingActivation): Promise<boolean> {
    this.validateRef(ref)
    const activated = await this.transport.activate({ ...ref }, this.context, { ...ownership })
    this.assertCurrent()
    return activated
  }

  flush(): Promise<void> {
    if (this.reservation) return this.reservation.flush()
    if (this.inFlight) return this.inFlight
    const flush = this.flushChanges()
    this.inFlight = flush
    void flush.finally(() => { if (this.inFlight === flush) this.inFlight = null }).catch(() => {})
    return flush
  }

  private async flushChanges(): Promise<void> {
    this.captureLive()
    while (this.isDirty || this.pendingCommit) {
      if (this.reservation) return
      this.assertCurrent()
      const request = this.pendingCommit ?? this.createCommit()
      this.pendingCommit = request
      await this.commitPending(request)
      this.captureLive()
    }
  }

  private async commitPending(request: WritingCommitRequest): Promise<void> {
    const result = await this.transport.commit(request)
    this.assertCurrent()
    if (result.status !== 'committed') throw new WritingCommitError(result)
    this.acknowledge(request, result)
    this.pendingCommit = null
  }

  reserveCommit(owner: { flush(): Promise<void> }): () => void {
    this.assertCurrent()
    if (this.reservation && this.reservation !== owner) throw new Error('Writing documents already belong to a compound commit.')
    this.reservation = owner
    return () => { if (this.reservation === owner) this.reservation = null }
  }

  async waitForCommit(): Promise<void> {
    if (this.inFlight) await this.inFlight
    this.assertCurrent()
    if (this.pendingCommit) {
      const settling = this.commitPending(this.pendingCommit)
      this.inFlight = settling
      try { await settling }
      finally { if (this.inFlight === settling) this.inFlight = null }
    }
  }

  prepareCommit(transactionId: string): WritingCommitRequest {
    this.assertCurrent()
    if (this.inFlight || this.pendingCommit) throw new Error('A writing commit is still in progress.')
    this.captureLive()
    return this.createCommit(transactionId)
  }

  acknowledgeCommit(request: WritingCommitRequest, result: Extract<WritingCommitResult, { status: 'committed' }>): void {
    this.assertCurrent()
    if (request.expectedEpoch !== this.context.workspaceEpoch) throw new WritingContextError()
    for (const change of [...request.changes, ...request.annotationChanges]) this.validateRef(change.ref)
    this.acknowledge(request, result)
  }

  private createCommit(transactionId: string = crypto.randomUUID()): WritingCommitRequest {
    const changes = [...this.documents.values()].flatMap(({ current, saved }) => {
      if (current.html === saved.html) return []
      return [{ ref: this.references.get(sceneRefKey(current))!, expectedRevision: saved.revision,
        expectedHash: saved.hash, beforeHtml: saved.html, afterHtml: current.html }]
    })
    return { transactionId, expectedEpoch: this.context.workspaceEpoch,
      changes, annotationChanges: structuredClone([...this.annotations.values()]) }
  }

  private acknowledge(request: WritingCommitRequest, result: Extract<WritingCommitResult, { status: 'committed' }>): void {
    const hashes = new Map(result.hashes.map(entry => [sceneRefKey(entry.ref), entry.hash]))
    const affected = new Set([...request.changes, ...request.annotationChanges].map(change => sceneRefKey(change.ref)))
    if ([...affected].some(key => !hashes.has(key))) throw new Error('Writing commit acknowledgement is incomplete.')
    for (const change of request.changes) {
      const key = sceneRefKey(change.ref)
      const document = this.documents.get(key)!
      const hash = hashes.get(key)!
      document.saved = Object.freeze({ ...document.current, html: change.afterHtml, hash })
      document.current = Object.freeze({ ...document.current, hash })
      this.notify(key, document.current)
    }
    for (const change of request.annotationChanges) {
      const key = sceneRefKey(change.ref)
      const pending = this.annotations.get(key)
      if (pending && sameAnnotations(pending.after, change.after)) this.annotations.delete(key)
      else if (pending) this.annotations.set(key, { ...pending, before: change.after })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.captureLive()
    await this.flush()
    if (this.isDirty) throw new Error('Writing documents still have unsaved changes.')
    this.closed = true
    this.unregisterPending()
    this.listeners.clear()
    this.captures.clear()
    this.documents.clear()
    this.references.clear()
  }
}

type WritingRpcRequest = <T>(method: string, params: unknown[]) => Promise<T>

async function requestWritingRpc<T>(method: string, params: unknown[]): Promise<T> {
  const { rpc } = await import('../rpc/client')
  return rpc.request<T>(method, params)
}

export function createWritingRpcTransport(request: WritingRpcRequest = requestWritingRpc): WritingDocumentTransport {
  return {
    read: ref => request('scenes/readPassive', [ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId]),
    activate: (ref, context, ownership) => request('scenes/activate', [ref.bookId, ref.draftId,
      ref.chapterGuid, ref.sceneId, context.workspaceEpoch, ownership.sourceId,
      ownership.focusGeneration, ownership.activationGeneration]),
    commit: commit => request('writing/commit', [commit])
  }
}

const registries = new Map<string, WritingDocumentRegistry>()

export function getWritingDocumentRegistry(options: WritingDocumentOptions): WritingDocumentRegistry {
  const key = writingContextKey(options.context)
  let registry = registries.get(key)
  if (!registry || registry.isClosed) {
    registry = new WritingDocumentRegistry(options)
    registries.set(key, registry)
  }
  return registry
}

export async function closeWritingDocumentRegistry(context: WritingContext): Promise<void> {
  const key = writingContextKey(context)
  const registry = registries.get(key)
  if (!registry) return
  await registry.close()
  registries.delete(key)
}
