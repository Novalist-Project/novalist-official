import * as Y from 'yjs'
import type { HistoryResult } from '../views/editor/writingTypes'
import type { SharedSceneSession } from './SharedSceneSession'
import { resolveSharedWritingSelection, type SharedWritingSelection } from './sharedWritingSelection'

export interface SharedWritingCapture { session: SharedSceneSession; apply(prose: Y.Text): void }
interface SceneHistory { session: SharedSceneSession; manager: Y.UndoManager; release(): void }
interface Group {
  origin: object
  scenes: Map<string, SceneHistory>
  state: 'open' | 'committed' | 'undone'
  selections?: { before: SharedWritingSelection | null; after: SharedWritingSelection | null }
}

export class SharedWritingHistory {
  private readonly groups = new Map<string, Group>()
  private current: string | null = null

  begin(id: string, origin: string): void {
    if (this.current || this.groups.has(id)) throw new Error('A shared writing transaction is already open or recorded.')
    this.groups.set(id, { origin: { id, writer: origin }, scenes: new Map(), state: 'open' })
    this.current = id
  }

  capture(sceneId: string, transaction: SharedWritingCapture): void {
    const group = this.current ? this.groups.get(this.current) : undefined
    if (!group) throw new Error('Begin a shared writing transaction before capturing it.')
    transaction.session.assertReady()
    let scene = group.scenes.get(sceneId)
    if (scene && scene.session !== transaction.session) throw new Error('A shared scene changed identity during the transaction.')
    if (!scene) {
      const manager = new Y.UndoManager(transaction.session.prose, { trackedOrigins: new Set([group.origin]), captureTimeout: Number.MAX_SAFE_INTEGER })
      const releaseOrigin = transaction.session.trackOrigin(group.origin)
      const releaseManager = transaction.session.trackOrigin(manager)
      scene = { session: transaction.session, manager, release: () => { releaseOrigin(); releaseManager(); manager.destroy() } }
      group.scenes.set(sceneId, scene)
    }
    transaction.session.transact(transaction.apply, group.origin)
  }

  commit(id: string): void {
    const group = this.groups.get(id)
    if (!group || this.current !== id) throw new Error('The shared writing transaction is not open.')
    for (const scene of group.scenes.values()) scene.manager.stopCapturing()
    group.state = 'committed'
    this.current = null
  }

  setSelections(id: string, before: SharedWritingSelection | null, after: SharedWritingSelection | null): void {
    const group = this.groups.get(id)
    if (!group) throw new Error('The shared writing transaction is unavailable.')
    group.selections = { before, after }
  }

  capturePending(id: string): void {
    const group = this.groups.get(id)
    if (!group) throw new Error('The shared writing transaction is unavailable.')
    for (const scene of group.scenes.values()) scene.session.assertReady()
    for (const scene of group.scenes.values()) scene.session.capture()
  }

  private change(id: string, redo: boolean): HistoryResult {
    const group = this.groups.get(id)
    if (!group || group.state !== (redo ? 'undone' : 'committed')) return { status: 'blocked', reason: 'writing.historyEmpty' }
    try {
      this.capturePending(id)
      for (const scene of group.scenes.values()) {
        if (redo) scene.manager.redo()
        else scene.manager.undo()
      }
      group.state = redo ? 'committed' : 'undone'
      return group.selections ? { status: 'applied', selection: resolveSharedWritingSelection(redo ? group.selections.after : group.selections.before) } : { status: 'applied' }
    } catch { return { status: 'blocked', reason: 'writing.historyConflict' } }
  }

  async undo(id: string): Promise<HistoryResult> { return this.change(id, false) }
  async redo(id: string): Promise<HistoryResult> { return this.change(id, true) }
  undoNow(id: string): HistoryResult { return this.change(id, false) }
  redoNow(id: string): HistoryResult { return this.change(id, true) }
  discard(id: string): void {
    const group = this.groups.get(id)
    if (!group) return
    if (this.current === id) throw new Error('Commit the shared writing transaction before discarding it.')
    for (const scene of group.scenes.values()) scene.release()
    this.groups.delete(id)
  }
  dispose(): void {
    for (const group of this.groups.values()) for (const scene of group.scenes.values()) scene.release()
    this.groups.clear()
    this.current = null
  }
}
