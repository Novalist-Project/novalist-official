import { registerPendingWrite } from './pendingWrites'
import type {
  AnnotationChange, SceneChange, SceneRef, SceneSnapshot, WritingCommitRequest,
  WritingCommitResult, WritingContext, WritingRegistry, WritingTransaction, WritingAnnotations, WritingActivation
} from '../views/editor/writingTypes'

export interface WritingDocumentTransport {
  read(ref: SceneRef): Promise<Pick<SceneSnapshot, 'html' | 'hash' | 'shared'> & { annotations?: WritingAnnotations; missing?: boolean }>
  activate(ref: SceneRef, context: WritingContext, ownership: WritingActivation): Promise<boolean>
  commit(request: WritingCommitRequest): Promise<WritingCommitResult>
}

export interface WritingDocumentOptions {
  context: WritingContext
  isCurrent(context: WritingContext): boolean
  transport?: WritingDocumentTransport
  onSaved?(context: WritingContext, current: SceneSnapshot): void
}

export interface ExternalWritingChange {
  ref: SceneRef
  before: SceneSnapshot
  afterHtml: string
  hash: string
}

export interface WritingRegistryRecovery {
  validate(next: WritingContext): void
  apply(next: WritingContext): void
  release(): void
  refresh(snapshot: SceneSnapshot, content: Awaited<ReturnType<WritingDocumentTransport['read']>>): void
}

interface WritingCommitReservation {
  flush(): Promise<void>
  prepareRecovery?(): Promise<(epoch: number) => void>
  prepareConflictResolution?(): Promise<(resolved: boolean) => void>
}

export interface WritingDiskConflict {
  context: WritingContext
  ref: SceneRef
  mine: string
  theirs: string
  diskHash: string
  resolution?: { transactionId: string; html: string }
}

export interface WritingDiskResolution {
  transactionId: string
  expectedEpoch: number
  ref: SceneRef
  expectedDiskHash: string
  mine: string
  html: string
  theirs: string
}

export type WritingDiskRefresh = { status: 'unchanged' | 'refreshed' } | { status: 'conflict'; conflict: WritingDiskConflict }

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
  private ownerContext: WritingContext
  private readonly transport: WritingDocumentTransport
  private readonly isCurrent: WritingDocumentOptions['isCurrent']
  private readonly onSaved: WritingDocumentOptions['onSaved']
  private readonly documents = new Map<string, Document>()
  private readonly reads = new Map<string, Promise<SceneSnapshot>>()
  private readonly references = new Map<string, SceneRef>()
  private readonly listeners = new Map<string, Map<Listener, number>>()
  private readonly dirtyListeners = new Map<string, Set<() => void>>()
  private readonly sceneListeners = new Set<(ref: SceneRef | null) => void>()
  private readonly captures = new Set<() => void>()
  private readonly annotations = new Map<string, AnnotationChange>()
  private readonly unregisterPending: () => void
  private inFlight: Promise<void> | null = null
  private retainedCommit: WritingCommitRequest | null = null
  private pendingCommitKeys = new Set<string>()
  private commitConflicted = false
  private pendingResolution: WritingDiskResolution | null = null
  private readonly diskConflictBases = new WeakMap<WritingDiskConflict, SceneSnapshot>()
  private reservation: WritingCommitReservation | null = null
  private recovering: { done: Promise<void>; release(): void } | null = null
  private external: { token: string; done: Promise<void>; release(): void } | null = null
  private closed = false

  constructor(options: WritingDocumentOptions) {
    this.ownerContext = Object.freeze({ ...options.context })
    this.isCurrent = options.isCurrent
    this.onSaved = options.onSaved
    this.transport = options.transport ?? createWritingRpcTransport()
    this.unregisterPending = registerPendingWrite(() => this.flush(), () => this.captureLive())
  }

  get isDirty(): boolean {
    return !!this.pendingCommit || !!this.pendingResolution || this.annotations.size > 0 || [...this.documents.values()].some(document => document.current.html !== document.saved.html)
  }

  private get pendingCommit(): WritingCommitRequest | null { return this.retainedCommit }
  private set pendingCommit(request: WritingCommitRequest | null) {
    const previous = this.pendingCommitKeys
    this.retainedCommit = request
    this.pendingCommitKeys = new Set(request ? [...request.changes, ...request.annotationChanges].map(change => sceneRefKey(change.ref)) : [])
    for (const key of new Set([...previous, ...this.pendingCommitKeys])) this.notifyDirty(key)
  }

  get isClosed(): boolean { return this.closed }
  get context(): WritingContext { return this.ownerContext }
  get isExternallyReserved(): boolean { return this.external !== null }

  async prepareRecovery(): Promise<WritingRegistryRecovery> {
    if (this.closed || this.external || this.recovering) throw new Error('Writing recovery owner is unavailable.')
    const expected = this.context
    let finish!: () => void
    const held = { done: new Promise<void>(resolve => { finish = resolve }), release: () => finish() }
    this.recovering = held
    const release = (): void => {
      if (this.recovering === held) { this.recovering = null; held.release() }
    }
    try {
      await Promise.allSettled([...this.reads.values(), ...(this.inFlight ? [this.inFlight] : [])])
      if (this.reservation && !this.reservation.prepareRecovery) throw new Error('The compound writing owner cannot recover yet.')
      const rebaseCommit = await this.reservation?.prepareRecovery?.()
      const validate = (next: WritingContext): void => {
        if (this.closed || this.recovering !== held || this.external || this.reads.size || this.inFlight ||
            writingContextKey(this.context) !== writingContextKey(expected) ||
            next.workspaceId !== expected.workspaceId || next.bookId !== expected.bookId || next.draftId !== expected.draftId ||
            !Number.isSafeInteger(next.workspaceEpoch) || next.workspaceEpoch < 0 || !this.isCurrent(next)) throw new WritingContextError()
      }
      return { validate, release, refresh: (snapshot, content) => {
        if (this.recovering !== held) throw new Error('Writing recovery owner is unavailable.')
        this.refreshRecoveredDocument(snapshot, content)
      }, apply: next => {
        validate(next)
        rebaseCommit?.(next.workspaceEpoch)
        if (this.pendingCommit) this.pendingCommit = { ...this.pendingCommit, expectedEpoch: next.workspaceEpoch }
        if (this.pendingResolution) this.pendingResolution = { ...this.pendingResolution, expectedEpoch: next.workspaceEpoch }
        this.ownerContext = Object.freeze({ ...next })
      } }
    } catch (error) { release(); throw error }
  }

  private refreshRecoveredDocument(snapshot: SceneSnapshot, content: Awaited<ReturnType<WritingDocumentTransport['read']>>): void {
    const key = this.validateRef(snapshot)
    const document = this.documents.get(key)
    if (!document || document.current !== snapshot) throw new Error('The recovering document changed during its read.')
    if (!!snapshot.shared !== !!content.shared || (snapshot.shared && snapshot.shared.itemId !== content.shared?.itemId)) throw new WritingContextError()
    if (snapshot.shared) {
      document.current = Object.freeze({ ...snapshot, shared: content.shared })
      document.saved = Object.freeze({ ...document.saved, shared: content.shared })
    } else if (!this.pendingCommit && !this.pendingResolution && !this.reservation && !content.missing && !this.annotations.has(key) && document.current.html === document.saved.html) {
      document.current = Object.freeze({ ...snapshot, html: content.html, hash: content.hash,
        revision: snapshot.revision + (snapshot.html === content.html ? 0 : 1) })
      document.saved = document.current
      if (content.annotations) document.annotations = structuredClone(content.annotations)
      this.onSaved?.(this.context, document.current)
    }
    this.notify(key, document.current)
  }

  rebindExternal(token: string, expected: WritingContext, next: WritingContext): void {
    if (this.closed || this.external?.token !== token) throw new Error('Writing external reservation is unavailable.')
    if (writingContextKey(this.context) !== writingContextKey(expected) ||
      expected.workspaceId !== next.workspaceId || expected.bookId !== next.bookId || expected.draftId !== next.draftId ||
      !Number.isSafeInteger(next.workspaceEpoch) || next.workspaceEpoch < 0 || !this.isCurrent(next)) throw new WritingContextError()
    if (this.reads.size || this.pendingCommit || this.reservation) throw new Error('Writing operations are still pending before recovery.')
    this.ownerContext = Object.freeze({ ...next })
  }

  acceptExternalSharedIdentity(token: string, ref: SceneRef, expected: NonNullable<SceneSnapshot['shared']>, next: NonNullable<SceneSnapshot['shared']>): void {
    const key = this.validateRef(ref)
    if (this.external?.token !== token) throw new Error('Writing external reservation is unavailable.')
    if (expected.itemId !== next.itemId || !next.sessionId || !next.itemId) throw new WritingContextError()
    const document = this.documents.get(key)
    if (!document) throw new Error('The shared writing document is unavailable.')
    const same = (value: SceneSnapshot['shared'], other: NonNullable<SceneSnapshot['shared']>): boolean =>
      value?.sessionId === other.sessionId && value.itemId === other.itemId && value.state === other.state
    if (same(document.current.shared, next) && same(document.saved.shared, next)) return
    if (!same(document.current.shared, expected) || !same(document.saved.shared, expected)) throw new WritingContextError()
    const shared = Object.freeze({ ...next })
    document.current = Object.freeze({ ...document.current, shared })
    document.saved = Object.freeze({ ...document.saved, shared })
    this.notify(key, document.current)
  }

  private assertCurrent(): void {
    if (this.closed || !this.isCurrent(this.context)) throw new WritingContextError()
  }

  private validateRef(ref: SceneRef): string {
    this.assertCurrent()
    if (ref.bookId !== this.context.bookId || ref.draftId !== this.context.draftId) throw new WritingContextError()
    return sceneRefKey(ref)
  }

  async read(ref: SceneRef): Promise<SceneSnapshot> {
    if (this.recovering) throw new Error('Writing documents are recovering.')
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

  captureExternal(): readonly { current: SceneSnapshot; saved: SceneSnapshot }[] {
    this.assertCurrent()
    return [...this.documents.values()].map(({ current, saved }) => ({ current, saved }))
  }

  async reserveExternal(token: string): Promise<() => void> {
    this.assertCurrent()
    if (this.recovering) throw new Error('Writing documents are recovering.')
    if (!token || this.external) throw new Error('Writing documents already have an external reservation.')
    if (this.reservation) await this.reservation.flush()
    await this.waitForCommit()
    this.captureLive()
    if (this.reservation || this.external || this.recovering) throw new Error('Writing documents are already reserved.')
    let finish!: () => void
    const lease = { token, done: new Promise<void>(resolve => { finish = resolve }), release: () => finish() }
    this.external = lease
    return () => {
      if (this.external !== lease) return
      this.external = null
      lease.release()
    }
  }

  acceptExternalCommit(token: string, changes: readonly ExternalWritingChange[]): void {
    this.assertCurrent()
    if (this.external?.token !== token) throw new Error('The external writing reservation is no longer current.')
    const seen = new Set<string>()
    const prepared = changes.map(change => {
      const key = this.validateRef(change.ref)
      if (seen.has(key)) throw new Error('Duplicate external writing change.')
      seen.add(key)
      const document = this.documents.get(key)
      if (!document || document.current.shared) throw new Error('External local writing document is unavailable.')
      if (sceneRefKey(change.before) !== key) throw new WritingContextError()
      const current = document.current
      const replay = current.revision === change.before.revision + 1 && current.html === change.afterHtml && current.hash === change.hash
      if (!replay && (current.revision !== change.before.revision || current.html !== change.before.html || current.hash !== change.before.hash)) {
        throw new Error('External writing revision conflict.')
      }
      return { key, document, change, replay }
    })
    for (const { document, change, replay } of prepared) {
      if (replay) continue
      document.current = Object.freeze({ ...document.current, html: change.afterHtml, hash: change.hash, revision: document.current.revision + 1 })
      document.saved = document.current
    }
    for (const { key, document, replay } of prepared) if (!replay) this.notify(key, document.current)
  }

  receiveSharedAnnotations(ref: SceneRef, annotations: WritingAnnotations): void {
    const key = this.validateRef(ref)
    const document = this.documents.get(key)
    if (!document?.current.shared) throw new Error('Shared writing document is unavailable.')
    document.annotations = structuredClone(annotations)
    this.notify(key, document.current)
  }

  getPendingDiskConflict(): WritingDiskConflict | null {
    this.assertCurrent()
    const pending = this.pendingResolution
    return pending ? { context: this.context, ref: { ...pending.ref }, mine: pending.mine,
      theirs: pending.theirs, diskHash: pending.expectedDiskHash,
      resolution: { transactionId: pending.transactionId, html: pending.html } } : null
  }

  getCurrentDiskConflict(conflict: WritingDiskConflict): WritingDiskConflict | null {
    this.assertCurrent()
    if (writingContextKey(conflict.context) !== writingContextKey(this.context) || this.external || this.recovering) return null
    const key = this.validateRef(conflict.ref)
    this.captureLive()
    const pending = this.getPendingDiskConflict()
    if (conflict.resolution) return pending && sceneRefKey(pending.ref) === key &&
      pending.resolution?.transactionId === conflict.resolution.transactionId && pending.resolution.html === conflict.resolution.html &&
      pending.mine === conflict.mine && pending.theirs === conflict.theirs && pending.diskHash === conflict.diskHash ? pending : null
    const document = this.documents.get(key)
    if (pending || !document || document.current.shared || this.diskConflictBases.get(conflict) !== document.saved) return null
    if (document.current.html === document.saved.html && !this.annotations.has(key) &&
        !this.pendingCommit?.changes.some(change => sceneRefKey(change.ref) === key)) return null
    const current = { ...conflict, mine: document.current.html }
    this.diskConflictBases.set(current, document.saved)
    return current
  }

  async refreshFromDisk(ref: SceneRef): Promise<WritingDiskRefresh> {
    const key = this.validateRef(ref)
    if (this.external || this.recovering) return { status: 'unchanged' }
    this.captureLive()
    const pending = this.getPendingDiskConflict()
    if (pending) return sceneRefKey(pending.ref) === key ? { status: 'conflict', conflict: pending } : { status: 'unchanged' }
    const document = this.documents.get(key)
    if (!document || document.current.shared) return { status: 'unchanged' }
    const saved = document.saved
    const annotations = document.annotations
    const context = this.context
    const content = await this.transport.read(ref)
    this.validateRef(ref)
    if (context !== this.context || this.external || this.recovering || this.pendingResolution ||
        document !== this.documents.get(key) || document.saved !== saved || document.annotations !== annotations) return { status: 'unchanged' }
    this.captureLive()
    if (content.shared || content.missing) return { status: 'unchanged' }
    if (content.hash === saved.hash) return this.refreshDiskAnnotations(key, document, content.annotations)
    if (document.current.html !== saved.html || this.annotations.has(key) ||
        this.pendingCommit?.changes.some(change => sceneRefKey(change.ref) === key)) {
      const conflict = { context, ref: { ...ref }, mine: document.current.html, theirs: content.html, diskHash: content.hash }
      this.diskConflictBases.set(conflict, saved)
      return { status: 'conflict', conflict }
    }
    document.current = Object.freeze({ ...document.current, html: content.html, hash: content.hash, revision: document.current.revision + 1 })
    document.saved = document.current
    if (content.annotations) document.annotations = structuredClone(content.annotations)
    this.notify(key, document.current)
    this.onSaved?.(this.context, document.current)
    return { status: 'refreshed' }
  }

  private refreshDiskAnnotations(key: string, document: Document, annotations?: WritingAnnotations): WritingDiskRefresh {
    const pending = this.annotations.get(key)
    const before = pending?.before ?? document.annotations
    if (!annotations || before && sameAnnotations(before, annotations)) return { status: 'unchanged' }
    if (pending || this.pendingCommit?.annotationChanges.some(change => sceneRefKey(change.ref) === key)) {
      throw new Error('writing.annotationConflict')
    }
    document.annotations = structuredClone(annotations)
    this.notify(key, document.current)
    return { status: 'refreshed' }
  }

  resolveDiskConflict(conflict: WritingDiskConflict, html: string,
    resolve: (request: WritingDiskResolution) => Promise<WritingCommitResult>): Promise<void> {
    const prior = this.inFlight
    const resolving = this.resolveDiskConflictCore(conflict, html, resolve, prior)
    this.inFlight = resolving
    void resolving.finally(() => { if (this.inFlight === resolving) this.inFlight = null }).catch(() => {})
    return resolving
  }

  private async resolveDiskConflictCore(conflict: WritingDiskConflict, html: string,
    resolve: (request: WritingDiskResolution) => Promise<WritingCommitResult>, prior: Promise<void> | null): Promise<void> {
    if (prior) await Promise.allSettled([prior])
    const key = this.validateRef(conflict.ref)
    const retry = this.pendingResolution
    const recoveredRetry = retry?.expectedEpoch === this.context.workspaceEpoch && sceneRefKey(retry.ref) === key &&
      retry.mine === conflict.mine && retry.theirs === conflict.theirs && retry.expectedDiskHash === conflict.diskHash &&
      conflict.context.workspaceId === this.context.workspaceId && conflict.context.bookId === this.context.bookId && conflict.context.draftId === this.context.draftId
    if ((!recoveredRetry && writingContextKey(conflict.context) !== writingContextKey(this.context)) || this.external || this.recovering) throw new WritingContextError()
    this.captureLive()
    const document = this.documents.get(key)
    if (!document || document.current.shared) throw new Error('Local writing conflict is unavailable.')
    if (this.pendingCommit && !this.commitConflicted) throw new Error('Resolve the unknown pending writing commit first.')
    if (this.pendingResolution && (sceneRefKey(this.pendingResolution.ref) !== key || this.pendingResolution.html !== html)) {
      throw new Error('Retry the pending conflict resolution before choosing another version.')
    }
    const release = await this.reservation?.prepareConflictResolution?.()
    let accepted = false
    try {
      const request = this.pendingResolution ?? { transactionId: crypto.randomUUID(), expectedEpoch: this.context.workspaceEpoch,
        ref: conflict.ref, expectedDiskHash: conflict.diskHash, mine: conflict.mine, html, theirs: conflict.theirs }
      this.pendingResolution = request
      const result = await resolve(request)
      this.validateRef(conflict.ref)
      if (result.status !== 'committed') {
        if (result.status === 'conflict') this.pendingResolution = null
        throw new WritingCommitError(result)
      }
      const hash = result.hashes.find(entry => sceneRefKey(entry.ref) === key)?.hash
      if (!hash) throw new Error('Conflict resolution acknowledgement is incomplete.')
      this.captureLive()
      const current = document.current
      document.saved = Object.freeze({ ...current, html: request.html, hash })
      document.current = Object.freeze({ ...current, html: current.html === request.mine ? request.html : current.html,
        hash, revision: current.revision + 1 })
      this.pendingCommit = null
      this.pendingResolution = null
      this.commitConflicted = false
      accepted = true
      this.notify(key, document.current)
      this.onSaved?.(this.context, document.current)
    } finally { release?.(accepted) }
  }

  getSnapshot(ref: SceneRef): SceneSnapshot | undefined {
    return this.documents.get(this.validateRef(ref))?.current
  }

  isSceneDirty(ref: SceneRef): boolean {
    const key = this.validateRef(ref), document = this.documents.get(key)
    return !!document && (document.current.html !== document.saved.html || this.annotations.has(key) ||
      this.pendingCommitKeys.has(key) || (!!this.pendingResolution && sceneRefKey(this.pendingResolution.ref) === key))
  }

  subscribeDirty(ref: SceneRef, changed: () => void): () => void {
    const key = this.validateRef(ref)
    const listeners = this.dirtyListeners.get(key) ?? new Set<() => void>()
    listeners.add(changed)
    this.dirtyListeners.set(key, listeners)
    return () => { listeners.delete(changed); if (!listeners.size) this.dirtyListeners.delete(key) }
  }

  observeScenes(changed: (ref: SceneRef | null) => void): () => void {
    this.sceneListeners.add(changed)
    return () => { this.sceneListeners.delete(changed) }
  }

  private notifyScene(ref: SceneRef | null): void {
    for (const changed of this.sceneListeners) {
      try { changed(ref) }
      catch (error) {
        if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
        else queueMicrotask(() => { throw error })
      }
    }
  }

  private notifyDirty(key: string): void {
    const ref = this.references.get(key)
    if (ref) this.notifyScene(ref)
    for (const changed of this.dirtyListeners.get(key) ?? []) {
      try { changed() }
      catch (error) {
        if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
        else queueMicrotask(() => { throw error })
      }
    }
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
    if (this.recovering) throw new Error('Writing documents are recovering.')
    if (this.external) throw new Error('Writing documents are reserved for an external operation.')
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
    this.notifyDirty(key)
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
    if (this.recovering) return this.recovering.done.then(() => this.flush())
    if (this.external) return this.external.done.then(() => this.flush())
    if (this.reservation) return this.reservation.flush()
    if (this.inFlight) return this.inFlight
    const flush = this.flushChanges()
    this.inFlight = flush
    void flush.finally(() => { if (this.inFlight === flush) this.inFlight = null }).catch(() => {})
    return flush
  }

  private async flushChanges(): Promise<void> {
    this.captureLive()
    if (this.pendingResolution) throw new Error('Retry the pending conflict resolution before saving.')
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
    this.commitConflicted = false
    const result = await this.transport.commit(request)
    this.assertCurrent()
    if (result.status !== 'committed') {
      this.commitConflicted = result.status === 'conflict'
      throw new WritingCommitError(result)
    }
    this.acknowledge(request, result)
    this.pendingCommit = null
  }

  reserveCommit(owner: WritingCommitReservation): () => void {
    this.assertCurrent()
    if (this.external) throw new Error('Writing documents are reserved for an external operation.')
    if (this.reservation && this.reservation !== owner) throw new Error('Writing documents already belong to a compound commit.')
    this.reservation = owner
    return () => { if (this.reservation === owner) this.reservation = null }
  }

  async waitForCommit(): Promise<void> {
    if (this.inFlight) await this.inFlight
    this.assertCurrent()
    if (this.pendingResolution) throw new Error('Retry the pending conflict resolution before saving.')
    if (this.pendingCommit) {
      const settling = this.commitPending(this.pendingCommit)
      this.inFlight = settling
      try { await settling }
      finally { if (this.inFlight === settling) this.inFlight = null }
    }
  }

  prepareCommit(transactionId: string): WritingCommitRequest {
    this.assertCurrent()
    if (this.pendingResolution) throw new Error('Retry the pending conflict resolution before saving.')
    if (this.external) throw new Error('Writing documents are reserved for an external operation.')
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
      this.onSaved?.(this.context, document.current)
    }
    for (const change of request.annotationChanges) {
      const key = sceneRefKey(change.ref)
      const pending = this.annotations.get(key)
      if (pending && sameAnnotations(pending.after, change.after)) this.annotations.delete(key)
      else if (pending) this.annotations.set(key, { ...pending, before: change.after })
    }
    for (const key of affected) this.notifyDirty(key)
  }

  async prepareClose(): Promise<() => void> {
    if (this.closed) return () => undefined
    this.captureLive()
    await this.flush()
    if (this.isDirty || this.external || this.recovering || this.reservation || this.inFlight) throw new Error('Writing documents still have pending operations.')
    return () => {
      if (this.closed) return
      this.closed = true
      this.notifyScene(null)
      this.sceneListeners.clear()
      this.unregisterPending()
      this.listeners.clear()
      this.dirtyListeners.clear()
      this.captures.clear()
      this.documents.clear()
      this.references.clear()
    }
  }

  async close(): Promise<void> { (await this.prepareClose())() }
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

export function getWritingRegistries(context: Pick<WritingContext, 'workspaceId' | 'workspaceEpoch'>): readonly WritingDocumentRegistry[] {
  return [...registries.values()].filter(registry => !registry.isClosed &&
    registry.context.workspaceId === context.workspaceId && registry.context.workspaceEpoch === context.workspaceEpoch)
}

export function getWritingWorkspaceRegistries(workspaceId: string): readonly WritingDocumentRegistry[] {
  return [...registries.values()].filter(registry => !registry.isClosed && registry.context.workspaceId === workspaceId)
}

export function validateRecoveredWritingRegistry(registry: WritingDocumentRegistry, recovery: WritingRegistryRecovery, next: WritingContext): void {
  recovery.validate(next)
  const existing = registries.get(writingContextKey(next))
  if (existing && existing !== registry && !existing.isClosed) throw new Error('The recovered workspace already has another writing owner.')
}

export function transferRecoveredWritingRegistry(registry: WritingDocumentRegistry, recovery: WritingRegistryRecovery, next: WritingContext): void {
  validateRecoveredWritingRegistry(registry, recovery, next)
  const previous = writingContextKey(registry.context)
  recovery.apply(next)
  if (registries.get(previous) === registry) registries.delete(previous)
  registries.set(writingContextKey(next), registry)
}

export function getWritingDocumentRegistry(options: WritingDocumentOptions): WritingDocumentRegistry {
  const key = writingContextKey(options.context)
  let registry = registries.get(key)
  if (!registry || registry.isClosed) {
    registry = new WritingDocumentRegistry(options)
    registries.set(key, registry)
  }
  return registry
}

export function transferExternalWritingRegistry(registry: WritingDocumentRegistry, token: string,
  expected: WritingContext, next: WritingContext): void {
  const key = writingContextKey(next)
  const existing = registries.get(key)
  if (existing && existing !== registry && !existing.isClosed) throw new Error('The recovered workspace already has another writing owner.')
  registry.rebindExternal(token, expected, next)
  const previous = writingContextKey(expected)
  if (registries.get(previous) === registry) registries.delete(previous)
  registries.set(key, registry)
}

export async function closeWritingDocumentRegistry(context: WritingContext): Promise<void> {
  (await prepareWritingDocumentClose(context))()
}

export async function prepareWritingDocumentClose(context: WritingContext): Promise<() => void> {
  const key = writingContextKey(context)
  const registry = registries.get(key)
  if (!registry) return () => undefined
  const dispose = await registry.prepareClose()
  return () => {
    dispose()
    if (registries.get(key) === registry) registries.delete(key)
  }
}
