import * as Y from 'yjs'
import type { SceneRef } from '../views/editor/writingTypes'
import type { SharedSceneIdentity } from '../../../shared/sharedScene'
import type { SharedSceneSession } from './SharedSceneSession'
import { encodeWritingUpdate as encode, decodeWritingUpdate as decode, previewWritingInverse } from './sharedWritingUpdates'

export interface SharedWritingGroupChange {
  ref: SceneRef
  identity: SharedSceneIdentity
  session: SharedSceneSession
  expectedRevision: number
  beforeHtml: string
  afterHtml: string
}
export interface SharedWritingGroupIntent {
  groupId: string
  changes: {
    ref: SceneRef
    sessionId: string
    itemId: string
    sourceState: string
    forwardUpdate: string
    inverseUpdate: string
    beforeHtml: string
    afterHtml: string
  }[]
}
interface Part { change: SharedWritingGroupChange; doc: Y.Doc; history: Y.UndoManager; inverted?: boolean }

function intentChange(part: Part, source: Uint8Array): SharedWritingGroupIntent['changes'][number] {
  const update = Y.encodeStateAsUpdate(part.doc, Y.encodeStateVector(part.change.session.doc))
  return { ref: { ...part.change.ref }, sessionId: part.change.identity.sessionId, itemId: part.change.identity.itemId,
    sourceState: encode(source), forwardUpdate: encode(update), inverseUpdate: encode(previewWritingInverse(source, update)),
    beforeHtml: part.change.session.html, afterHtml: part.change.session.htmlForState(Y.encodeStateAsUpdate(part.doc)) }
}

export class PreparedSharedWritingGroup {
  private leases: (() => void)[]
  private pending: 'forward' | 'undo' | 'redo' | null = 'forward'
  private state: 'forward' | 'undone' = 'forward'
  private lastDirection: 'forward' | 'undo' | 'redo' = 'forward'
  private rolledBack = false
  private disposed = false

  constructor(private current: SharedWritingGroupIntent, private readonly parts: Part[], leases: (() => void)[]) {
    this.leases = leases
  }
  get intent(): SharedWritingGroupIntent { return structuredClone(this.current) }
  private assertOpen(): void { if (this.disposed) throw new Error('The shared writing group is closed.') }

  markPublished(): void {
    this.assertOpen()
    if (this.rolledBack) throw new Error('The shared writing intent was compensated.')
    if (this.pending === null) return
    for (let index = 0; index < this.parts.length; index++) {
      this.parts[index].change.session.applyExternal(this.current.groupId, decode(this.current.changes[index].forwardUpdate))
    }
    this.state = this.pending === 'undo' ? 'undone' : 'forward'
    this.pending = null
  }

  markRolledBack(): void {
    this.assertOpen()
    if (this.rolledBack) return
    for (let index = 0; index < this.parts.length; index++) {
      const change = this.current.changes[index]
      const part = this.parts[index]
      Y.applyUpdate(part.doc, decode(change.forwardUpdate))
      part.history.destroy()
      const origin = {}
      part.history = new Y.UndoManager(part.doc.getText('prose'), { trackedOrigins: new Set([origin]) })
      Y.applyUpdate(part.doc, decode(change.inverseUpdate), origin)
      part.inverted = this.lastDirection !== 'undo'
      part.change.session.applyExternal(this.current.groupId, Y.mergeUpdates([decode(change.forwardUpdate), decode(change.inverseUpdate)]))
    }
    this.state = this.lastDirection === 'undo' ? 'forward' : 'undone'
    this.rolledBack = true
    this.pending = null
  }

  async publish(): Promise<void> {
    this.assertOpen()
    for (let index = 0; index < this.parts.length; index++) this.parts[index].change.session.publishExternal(this.current.groupId, decode(this.current.changes[index].forwardUpdate))
    await Promise.all(this.parts.map(part => part.change.session.flush()))
    this.markPublished()
  }

  async rollback(): Promise<void> {
    this.assertOpen()
    for (let index = 0; index < this.parts.length; index++) {
      const change = this.current.changes[index]
      this.parts[index].change.session.publishExternal(this.current.groupId, Y.mergeUpdates([decode(change.forwardUpdate), decode(change.inverseUpdate)]))
    }
    await Promise.all(this.parts.map(part => part.change.session.flush()))
    this.markRolledBack()
  }

  private async prepare(direction: 'undo' | 'redo'): Promise<SharedWritingGroupIntent> {
    this.assertOpen()
    if (this.pending === direction) return this.intent
    if (this.pending || this.leases.length || this.state !== (direction === 'undo' ? 'forward' : 'undone')) throw new Error('Resolve the pending shared writing group first.')
    await Promise.all(this.parts.map(part => part.change.session.flush()))
    const groupId = crypto.randomUUID()
    try {
      for (const part of this.parts) this.leases.push(part.change.session.reserveExternal(groupId))
      const changes = this.parts.map(part => {
        const source = part.change.session.state()
        Y.applyUpdate(part.doc, source)
        if ((direction === 'undo') !== !!part.inverted) part.history.undo()
        else part.history.redo()
        return intentChange(part, source)
      })
      this.current = { groupId, changes }
      this.pending = direction
      this.lastDirection = direction
      this.rolledBack = false
      return this.intent
    } catch (error) { this.release(); throw error }
  }

  prepareUndo(): Promise<SharedWritingGroupIntent> { return this.prepare('undo') }
  prepareRedo(): Promise<SharedWritingGroupIntent> { return this.prepare('redo') }
  release(): void { for (const release of this.leases.splice(0)) release() }
  dispose(): void {
    this.release()
    for (const part of this.parts) { part.history.destroy(); part.doc.destroy() }
    this.disposed = true
  }
}

export async function prepareSharedWritingGroup(groupId: string, changes: readonly SharedWritingGroupChange[]): Promise<PreparedSharedWritingGroup> {
  if (!groupId || !changes.length) throw new Error('A shared writing group needs an identity and changes.')
  if (new Set(changes.map(change => change.session)).size !== changes.length) throw new Error('A shared document cannot appear twice in a prepared group.')
  await Promise.all(changes.map(change => change.session.flush()))
  const parts: Part[] = []
  const leases: (() => void)[] = []
  try {
    for (const change of changes) {
      if (change.session.revision !== change.expectedRevision || change.session.html !== change.beforeHtml) throw new Error('The shared writing group has stale content.')
      leases.push(change.session.reserveExternal(groupId))
      const source = change.session.state()
      const doc = new Y.Doc()
      Y.applyUpdate(doc, source)
      const origin = {}
      const history = new Y.UndoManager(doc.getText('prose'), { trackedOrigins: new Set([origin]) })
      const part = { change, doc, history }
      parts.push(part)
      const apply = change.session.prepareChange(change.afterHtml)
      doc.transact(() => apply(doc.getText('prose')), origin)
      if (change.session.htmlForState(Y.encodeStateAsUpdate(doc)) !== change.afterHtml) throw new Error('The shared writing group changes canonical HTML.')
    }
    return new PreparedSharedWritingGroup({ groupId, changes: parts.map(part => intentChange(part, part.change.session.state())) }, parts, leases)
  } catch (error) {
    for (const release of leases) release()
    for (const part of parts) { part.history.destroy(); part.doc.destroy() }
    throw error
  }
}
