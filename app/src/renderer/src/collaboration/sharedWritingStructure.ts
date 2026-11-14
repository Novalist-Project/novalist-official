import * as Y from 'yjs'
import type { SharedSceneIdentity } from '../../../shared/sharedScene'
import type { SharedSceneSession } from './SharedSceneSession'
import { createWritingRpcTransport, type WritingDocumentRegistry } from '../stores/writingDocuments'
import type { SceneRef } from '../views/editor/writingTypes'
import { encodeWritingUpdate as encode, decodeWritingUpdate as decode, previewWritingInverse as previewInverse } from './sharedWritingUpdates'

interface SplitHtml { sourceHtml: string; beforeHtml: string; afterHtml: string }
export interface SharedSplitPayload {
  sessionId: string
  itemId: string
  sourceState: string
  retainedUpdate: string
  createdItemId: string
  createdState: string
  undoUpdate: string
}
export interface SharedStructureInverse {
  sessionId: string
  itemId: string
  sourceState: string
  update: string
  createdItemId?: string
  createdState?: string
}
interface BindingTransfer {
  find(identity: SharedSceneIdentity): SharedSceneSession | undefined
  transfer(previous: SharedSceneIdentity, next: SharedSceneIdentity): void
}
interface PendingInverse { direction: 'undo' | 'redo'; payload: SharedStructureInverse }

export class PreparedSharedWritingStructure {
  private releaseSource: (() => void) | null
  private releaseChild: (() => void) | null = null
  private pending: PendingInverse | null = null
  private direction: 'split' | 'undone' = 'split'
  private child: SharedSceneIdentity
  private disposed = false
  private initialApplied = false
  private lastInverse: 'undo' | 'redo' | null = null

  constructor(readonly expectedHash: string, readonly sharedSplit: SharedSplitPayload,
    private readonly owner: SharedSceneSession, private readonly doc: Y.Doc,
    private readonly history: Y.UndoManager, private readonly token: string, release: () => void,
    private readonly bindings?: BindingTransfer) {
    this.releaseSource = release
    this.child = { sessionId: sharedSplit.sessionId, itemId: sharedSplit.createdItemId, state: sharedSplit.createdState }
  }

  applied(): void {
    this.assertOpen()
    if (this.initialApplied) return
    this.owner.applyExternal(this.token, decode(this.sharedSplit.retainedUpdate))
    this.release()
    this.initialApplied = true
  }

  rejected(): void { this.release() }
  async prepareRetry(): Promise<void> {
    this.assertOpen()
    await this.owner.flush()
    const childOwner = this.bindings?.find(this.child)
    if (childOwner) await childOwner.flush()
    if (!this.releaseSource) this.releaseSource = this.owner.reserveExternal(this.token)
    if (childOwner && !this.releaseChild) this.releaseChild = childOwner.reserveExternal(this.token)
  }
  private assertOpen(): void { if (this.disposed) throw new Error('The shared structure history is closed.') }
  private release(): void {
    this.releaseSource?.()
    this.releaseSource = null
    this.releaseChild?.()
    this.releaseChild = null
  }

  private async prepare(direction: 'undo' | 'redo'): Promise<SharedStructureInverse> {
    this.assertOpen()
    if (this.pending && this.pending.direction !== direction) throw new Error('Resolve the pending shared structure inverse first.')
    if (this.pending) { await this.prepareRetry(); return { ...this.pending.payload } }
    if (!this.pending && this.direction !== (direction === 'undo' ? 'split' : 'undone')) throw new Error('The shared structure history direction is stale.')
    await this.prepareRetry()
    const childOwner = this.bindings?.find(this.child)
    const source = this.owner.state()
    Y.applyUpdate(this.doc, source)
    if (!this.pending) {
      if (direction === 'undo') this.history.undo()
      else this.history.redo()
      this.pending = { direction, payload: { sessionId: this.sharedSplit.sessionId, itemId: this.sharedSplit.itemId,
        sourceState: encode(source), update: '', ...(direction === 'redo' ? {
          createdItemId: crypto.randomUUID(), createdState: childOwner ? encode(childOwner.state()) : this.child.state
        } : {}) } }
    }
    this.pending.payload.sourceState = encode(source)
    this.pending.payload.update = encode(Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.owner.doc)))
    return { ...this.pending.payload }
  }

  prepareUndo(): Promise<SharedStructureInverse> { return this.prepare('undo') }
  prepareRedo(): Promise<SharedStructureInverse> { return this.prepare('redo') }

  appliedInverse(direction: 'undo' | 'redo'): void {
    this.assertOpen()
    const pending = this.pending
    if (!pending && this.lastInverse === direction) return
    if (!pending || pending.direction !== direction) throw new Error('The shared structure inverse was not prepared.')
    this.owner.applyExternal(this.token, decode(pending.payload.update))
    this.release()
    if (direction === 'redo') {
      const next = { sessionId: this.child.sessionId, itemId: pending.payload.createdItemId!, state: pending.payload.createdState! }
      this.bindings?.transfer(this.child, next)
      this.child = next
    }
    this.direction = direction === 'undo' ? 'undone' : 'split'
    this.pending = null
    this.lastInverse = direction
  }

  dispose(): void {
    this.release()
    this.history.destroy()
    this.doc.destroy()
    this.disposed = true
  }
}

export async function prepareSharedWritingSplit(owner: SharedSceneSession, identity: SharedSceneIdentity,
  html: SplitHtml, expectedHash: string, bindings?: BindingTransfer): Promise<PreparedSharedWritingStructure> {
  await owner.flush()
  if (owner.html !== html.sourceHtml) throw new Error('The shared split source changed before preparation.')
  const createdState = owner.seedHtml(html.afterHtml)
  const apply = owner.prepareChange(html.beforeHtml)
  const source = owner.state()
  const doc = new Y.Doc()
  Y.applyUpdate(doc, source)
  const origin = {}
  const history = new Y.UndoManager(doc.getText('prose'), { trackedOrigins: new Set([origin]) })
  try {
    const vector = Y.encodeStateVector(doc)
    doc.transact(() => apply(doc.getText('prose')), origin)
    if (owner.htmlForState(Y.encodeStateAsUpdate(doc)) !== html.beforeHtml) throw new Error('The shared split changes canonical HTML.')
    const retained = Y.encodeStateAsUpdate(doc, vector)
    const retainedUpdate = encode(retained)
    const undoUpdate = encode(previewInverse(source, retained))
    const token = crypto.randomUUID()
    const release = owner.reserveExternal(token)
    return new PreparedSharedWritingStructure(expectedHash, { sessionId: identity.sessionId, itemId: identity.itemId,
      sourceState: encode(source), retainedUpdate, createdItemId: crypto.randomUUID(), createdState: encode(createdState),
      undoUpdate }, owner, doc, history, token, release, bindings)
  } catch (error) { history.destroy(); doc.destroy(); throw error }
}

export async function prepareSharedWritingStructure(command: { kind: string; ref?: SceneRef; sourceHtml?: string; beforeHtml?: string; afterHtml?: string },
  registry: WritingDocumentRegistry): Promise<PreparedSharedWritingStructure | null> {
  if ((command.kind !== 'splitScene' && command.kind !== 'splitChapter') || !command.ref) return null
  const identity = registry.getSnapshot(command.ref)?.shared
  if (!identity) return null
  if (command.sourceHtml === undefined || command.beforeHtml === undefined || command.afterHtml === undefined) throw new Error('The shared split content is incomplete.')
  const sessions = await import('./sharedWritingSessions')
  const owner = sessions.getSharedWritingSession(identity)
  await owner.flush()
  const passive = await createWritingRpcTransport().read(command.ref)
  if (passive.html !== command.sourceHtml || owner.html !== command.sourceHtml) throw new Error('The shared split source changed before preparation.')
  return prepareSharedWritingSplit(owner, identity, { sourceHtml: command.sourceHtml, beforeHtml: command.beforeHtml, afterHtml: command.afterHtml }, passive.hash,
    { find: sessions.findSharedWritingSession, transfer: sessions.transferSharedWritingSession })
}
