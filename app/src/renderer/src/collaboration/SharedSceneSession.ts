import * as Y from 'yjs'
import { SceneMarkup, type MarkupEnvironment } from './sceneMarkup'
import { SceneUpdateInbox } from './SceneUpdateInbox'
import { validateSceneUpdate } from './validateSceneUpdate'
import { registerPendingWrite } from '../stores/pendingWrites'
import type { SharedEditorConnection } from './SharedEditorSession'
import { updateRichText, type TextRun } from './richText'
import { writingTextMapping } from '../views/editor/writingTextMapping'
import type { WritingPoint } from '../views/editor/writingTypes'
import { ProseDocumentHost } from '../../../shared/ProseDocumentHost'

export interface SharedSceneBinding {
  capture(): void
  isComposing(): boolean
  assertReady(): void
  render(): void
  prepare(html: string): TextRun[] | undefined
  setReadOnly(readOnly: boolean): void
}

/** The collaborative document and outbound queue outlive every mounted surface. */
export class SharedSceneSession {
  readonly doc = new Y.Doc()
  readonly prose = this.doc.getText('prose')
  readonly localOrigin = {}
  readonly history = new Y.UndoManager(this.prose, { trackedOrigins: new Set([this.localOrigin]) })
  private readonly origins = new Set<unknown>([this.localOrigin, this.history])
  private readonly bindings = new Set<SharedSceneBinding>()
  private readonly listeners = new Set<() => void>()
  private observers = 0
  private readonly pending: Uint8Array[] = []
  private readonly remotePending: Uint8Array[] = []
  private remoteBytes = 0
  private readonly updates: SceneUpdateInbox
  private readonly markup: SceneMarkup
  private readonly root: HTMLElement
  private unsubscribe: () => void
  private readonly unregisterPending: () => void
  private writing: Promise<void> | null = null
  private failure: Error | null = null
  private closed = false
  private currentRevision = 0
  private cachedHtml: string | null = null
  private renderedRevision = -1
  private reservation: string | null = null
  private recovering = false

  constructor(private readonly environment: MarkupEnvironment, initialState: Uint8Array, private connection: SharedEditorConnection) {
    this.root = environment.document.createElement('div')
    this.markup = new SceneMarkup(environment, this.root)
    validateSceneUpdate(this.doc, initialState, this.markup, true)
    Y.applyUpdate(this.doc, initialState)
    this.updates = new SceneUpdateInbox(this.doc, this.markup)
    this.doc.on('update', this.updated)
    this.unsubscribe = connection.subscribe(this.receiveConnected)
    this.unregisterPending = registerPendingWrite(() => this.flush(), () => this.capture())
  }

  private readonly receiveConnected = (update: Uint8Array): void => {
      try { this.receive(update) }
      catch { this.failure = new Error('A shared scene update could not be applied.'); this.publish() }
  }

  get dirty(): boolean { return this.pending.length > 0 }
  get error(): Error | null { return this.failure }
  get isClosed(): boolean { return this.closed }
  get revision(): number { return this.currentRevision }
  get html(): string {
    if (this.cachedHtml === null) {
      this.renderCurrentMarkup()
      this.cachedHtml = this.root.innerHTML
    }
    return this.cachedHtml
  }
  get hasHistory(): boolean { return this.history.undoStack.length > 0 || this.history.redoStack.length > 0 || this.origins.size > 2 }

  relativePoint(point: WritingPoint): Y.RelativePosition {
    this.renderCurrentMarkup()
    const position = writingTextMapping.domPoint(this.root, point.offset, point.affinity)
    const index = this.markup.position(position.node, position.offset)
    if (index === null) throw new Error('The shared selection cannot be mapped to its document.')
    return Y.createRelativePositionFromTypeIndex(this.prose, index, point.affinity === 'before' ? -1 : 0)
  }

  resolvePoint(position: Y.RelativePosition): number | null {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, this.doc)
    if (!absolute || absolute.type !== this.prose) return null
    this.renderCurrentMarkup()
    const point = this.markup.domPosition(absolute.index)
    return point ? writingTextMapping.offset(this.root, point.node, point.offset) : null
  }

  private renderCurrentMarkup(): void {
    if (this.renderedRevision === this.currentRevision) return
    this.markup.render(this.prose.toDelta())
    this.renderedRevision = this.currentRevision
  }

  subscribe(changed: () => void): () => void { this.listeners.add(changed); return () => { this.listeners.delete(changed) } }
  /** Retain the current document for a reader that outlives its writing surface. */
  observe(changed: () => void): () => void {
    this.assertOpen()
    this.observers++
    const unsubscribe = this.subscribe(changed)
    let active = true
    return () => {
      if (!active) return
      active = false
      unsubscribe()
      this.observers--
    }
  }
  bind(binding: SharedSceneBinding): () => void {
    this.assertOpen()
    this.bindings.add(binding)
    if (this.reservation || this.recovering) binding.setReadOnly(true)
    return () => { this.bindings.delete(binding); binding.setReadOnly(false) }
  }

  reserveExternal(token: string): () => void {
    this.assertReady()
    if (!token || this.reservation || this.dirty || this.writing) throw new Error('The shared writing document is already reserved or still saving.')
    this.capture()
    if (this.dirty) throw new Error('Flush the captured shared document before reserving it.')
    this.reservation = token
    for (const binding of this.bindings) binding.setReadOnly(true)
    return () => {
      if (this.reservation !== token) return
      this.reservation = null
      for (const binding of this.bindings) binding.setReadOnly(false)
      this.drainRemoteUpdates()
    }
  }

  applyExternal(token: string, update: Uint8Array): void {
    if (this.reservation !== token) throw new Error('The shared writing reservation is no longer current.')
    const rejected = this.updates.receive(update)
    if (rejected.length) throw rejected[0]
  }

  publishExternal(token: string, update: Uint8Array): void {
    this.applyExternal(token, update)
    this.pending.push(update.slice())
    this.startWriting()
    this.publish()
  }

  rebindConnection(connection: SharedEditorConnection, state: Uint8Array): void {
    this.assertReady()
    if (this.dirty || this.writing || this.reservation) throw new Error('Flush shared edits before transferring their binding.')
    this.receive(state)
    this.unsubscribe()
    this.connection = connection
    this.unsubscribe = connection.subscribe(this.receiveConnected)
  }

  async rebindRecoveredConnection(connection: SharedEditorConnection, state: Uint8Array): Promise<void> {
    this.assertWritable()
    if (this.reservation) throw new Error('The shared writing document is reserved for an external operation.')
    this.capture()
    const retained = this.pending.slice()
    this.recovering = true
    let connected = false
    try {
      for (const binding of this.bindings) binding.setReadOnly(true)
      if (this.writing) await this.writing
      // An old acknowledgement cannot prove the recovered backend retained that update.
      if (retained.length) this.pending.splice(0, this.pending.length, Y.mergeUpdates([...retained, ...this.pending]))
      validateSceneUpdate(this.doc, state, this.markup, true)
      const rejected = this.updates.receive(state)
      if (rejected.length) throw rejected[0]
      this.updates.assertComplete()
      const unsubscribe = connection.subscribe(this.receiveConnected)
      this.unsubscribe()
      this.connection = connection
      this.unsubscribe = unsubscribe
      this.failure = null
      connected = true
    } finally {
      this.recovering = false
      for (const binding of this.bindings) binding.setReadOnly(false)
      this.drainRemoteUpdates()
      if (connected) this.startWriting()
      this.publish()
    }
  }

  rebindExternalConnection(token: string, connection: SharedEditorConnection, state: Uint8Array): void {
    this.assertReady()
    if (!token || this.reservation !== token) throw new Error('The shared writing reservation is no longer current.')
    if (this.dirty || this.writing) throw new Error('Settle shared writes before reconnecting their reserved owner.')
    validateSceneUpdate(this.doc, state, this.markup, true)
    this.applyExternal(token, state)
    this.unsubscribe()
    this.connection = connection
    this.unsubscribe = connection.subscribe(this.receiveConnected)
  }

  seedHtml(html: string): Uint8Array {
    const host = new ProseDocumentHost(this.environment.document, this.environment)
    try {
      const state = host.seed('scene', html)
      if (host.project('scene') !== html) throw new Error('Shared scene encoding changes canonical HTML.')
      return state
    } finally { host.dispose() }
  }

  htmlForState(state: Uint8Array): string {
    const host = new ProseDocumentHost(this.environment.document, this.environment)
    try { host.load('scene', state); return host.project('scene')! }
    finally { host.dispose() }
  }

  private assertOpen(): void { if (this.closed) throw new Error('The shared writing session is closed.') }
  assertReady(): void {
    this.assertWritable()
    this.updates.assertComplete()
  }

  private assertWritable(): void {
    this.assertOpen()
    if (this.recovering) throw new Error('The shared writing session is recovering its connection.')
    for (const binding of this.bindings) binding.assertReady()
  }

  capture(): void { if (!this.reservation && !this.recovering) for (const binding of this.bindings) binding.capture() }
  prepareChange(html: string): (prose: Y.Text) => void {
    this.assertReady()
    let runs: TextRun[] | undefined
    for (const binding of this.bindings) { runs = binding.prepare(html); if (runs) break }
    if (!runs) {
      this.renderedRevision = -1
      this.cachedHtml = null
      this.root.replaceChildren(this.environment.sanitizeSceneFragment(html))
      runs = this.markup.read()
    }
    this.markup.prepare(runs)
    const prepared = runs
    return prose => updateRichText(prose, prepared)
  }
  trackOrigin(origin: unknown): () => void { this.origins.add(origin); return () => { this.origins.delete(origin) } }
  transact(apply: (prose: Y.Text) => void, origin: unknown = this.localOrigin): void {
    this.assertWritable()
    if (this.reservation) throw new Error('The shared writing document is reserved for an external operation.')
    this.doc.transact(() => apply(this.prose), origin)
  }

  private readonly updated = (update: Uint8Array, origin: unknown): void => {
    this.currentRevision++
    this.cachedHtml = null
    if (this.origins.has(origin)) {
      this.pending.push(update.slice())
      this.startWriting()
    }
    for (const binding of this.bindings) this.notify(() => binding.render())
    this.publish()
  }

  receive(update: Uint8Array): void {
    this.assertOpen()
    if (this.reservation || this.recovering || [...this.bindings].some(binding => binding.isComposing())) {
      if (this.remoteBytes + update.byteLength > 8 * 1024 * 1024) throw new Error('Confirm the composition before receiving more shared edits.')
      this.remotePending.push(update.slice())
      this.remoteBytes += update.byteLength
      return
    }
    this.assertWritable()
    this.capture()
    const rejected = this.updates.receive(update)
    if (rejected.length) { this.failure = rejected[0]; this.publish() }
  }

  drainRemoteUpdates(): void {
    if (this.reservation || this.recovering || [...this.bindings].some(binding => binding.isComposing())) return
    while (this.remotePending.length) {
      const update = this.remotePending.shift()!
      this.remoteBytes -= update.byteLength
      try { this.receive(update) }
      catch { this.failure = new Error('An invalid shared edit was rejected after the document reservation.'); this.publish() }
    }
  }

  async refresh(): Promise<void> { this.receive(await this.connection.read()) }
  state(): Uint8Array { this.capture(); this.assertReady(); return Y.encodeStateAsUpdate(this.doc) }
  undo(): void { this.assertReady(); this.capture(); this.history.undo() }
  redo(): void { this.assertReady(); this.capture(); this.history.redo() }

  private publish(): void { for (const listener of this.listeners) this.notify(listener) }
  private notify(listener: () => void): void {
    try { listener() }
    catch (error) {
      if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
      else queueMicrotask(() => { throw error })
    }
  }
  private startWriting(): void {
    if (!this.recovering && !this.writing && this.pending.length) this.writing = Promise.resolve().then(() => this.writePending())
  }

  private async writePending(): Promise<void> {
    try {
      while (!this.recovering && this.pending.length) {
        const count = this.pending.length
        await this.connection.write(count === 1 ? this.pending[0] : Y.mergeUpdates(this.pending.slice(0, count)))
        this.pending.splice(0, count)
        this.failure = null
        this.publish()
      }
    } catch {
      this.failure = new Error('Shared edits are still waiting to be saved. Retry before closing this project.')
      this.publish()
    } finally { this.writing = null }
  }

  async flush(): Promise<void> {
    this.assertReady()
    this.capture()
    if (this.writing) await this.writing
    this.startWriting()
    if (this.writing) await this.writing
    if (this.dirty) throw this.failure ?? new Error('Shared edits have not been saved.')
  }

  async prepareClose(): Promise<() => void> {
    if (this.closed) return () => undefined
    if (this.reservation) throw new Error('Resolve the reserved shared operation before closing the writing session.')
    await this.flush()
    if (this.bindings.size) throw new Error('Detach the shared writing surfaces before closing their session.')
    return () => this.dispose()
  }

  async close(): Promise<void> { (await this.prepareClose())() }

  releaseUnused(): boolean {
    if (this.reservation || this.recovering || this.bindings.size || this.observers || this.dirty || this.writing || this.hasHistory || this.remotePending.length) return false
    this.dispose()
    return true
  }

  private dispose(): void {
    if (this.closed) return
    this.unsubscribe()
    this.unregisterPending()
    this.listeners.clear()
    this.history.destroy()
    this.doc.off('update', this.updated)
    this.doc.destroy()
    this.closed = true
  }
}
