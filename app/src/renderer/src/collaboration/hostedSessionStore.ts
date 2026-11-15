import { create } from 'zustand'
import { rpc } from '../rpc/client'
import { useHostBridgeStore } from '../stores/hostBridgeStore'
import { readPreference } from './projectPreferences'

interface HostedSession {
  sessionId: string
  projectId: string
  server: string
  connection: string
  isOwner: boolean
  recoveryPath: string | null
  mode: 'hosted' | 'persistent' | 'tcp' | 'steam'
  hasPendingUpdates?: boolean
  conflicts?: number
}

/** A place this device and another writer both changed while this device was disconnected. */
export interface MergeConflict {
  path: string
  id: string
  kind: 'prose' | 'field' | 'structure' | 'file'
  label: string
  local: string | null
  server: string | null
}
export type MergeChoice = 'local' | 'server'

interface SavedHostedProject { server: string; projectId: string; recoveryPath: string | null; mode: 'hosted' | 'persistent' }
export interface CollaborationTransferProgress {
  phase: 'scanning' | 'connecting' | 'comparing' | 'transferring' | 'installing' | 'complete'
  completedFiles: number
  totalFiles: number
  completedBytes: number
  totalBytes: number
  reusedFiles: number
}
type Operation = 'create' | 'join' | 'invite' | 'end' | 'resume' | 'persistentCreate' | 'persistentJoin' | 'persistentResume' | 'copy' | 'peerHost' | 'peerJoin' | 'steamHost' | 'steamJoin'
interface HostedSessionState {
  session: HostedSession | null
  saved: SavedHostedProject | null
  copied: boolean
  busy: Operation | null
  invitation: string
  error: string
  presenceUnavailable: boolean
  presenceFailures: string[]
  transfer: CollaborationTransferProgress | null
  hostSynchronizing: boolean
  cancelling: boolean
  conflicts: MergeConflict[]
  conflictsOpen: boolean
  showConflicts(open: boolean): void
  loadConflicts(): Promise<void>
  resolveConflicts(choices: { path: string; id: string; keep: MergeChoice }[]): Promise<void>
  cancel(): Promise<void>
  reportPresence(sessionId: string, viewId: string, unavailable: boolean): void
  refresh(isCurrent?: () => boolean): Promise<void>
  autoReconnect(project: string): Promise<void>
  run(operation: Operation, params?: unknown[]): Promise<void>
}

export const useHostedSessionStore = create<HostedSessionState>((set, get) => ({
  session: null,
  saved: null,
  copied: false,
  busy: null,
  invitation: '',
  error: '',
  presenceUnavailable: false,
  presenceFailures: [],
  transfer: null,
  hostSynchronizing: false,
  cancelling: false,
  conflicts: [],
  conflictsOpen: false,
  showConflicts(open) { set({ conflictsOpen: open && get().conflicts.length > 0 }) },
  async loadConflicts() {
    const conflicts = await rpc.request<MergeConflict[]>('collaboration/persistent/conflicts')
    set({ conflicts, conflictsOpen: conflicts.length > 0 })
  },
  async resolveConflicts(choices) {
    const session = await rpc.request<HostedSession>('collaboration/persistent/resolveConflicts', [choices])
    set({ session, conflicts: [], conflictsOpen: false })
  },
  async cancel() {
    if ((!get().busy && !get().hostSynchronizing) || get().cancelling) return
    set({ cancelling: true })
    try { await rpc.request('collaboration/cancel') }
    catch (error) { set({ error: String(error), cancelling: false }) }
  },
  reportPresence(sessionId, viewId, unavailable) {
    const state = get()
    if (state.session?.sessionId !== sessionId || state.presenceFailures.includes(viewId) === unavailable) return
    const failures = state.presenceFailures.filter(view => view !== viewId)
    if (unavailable) failures.push(viewId)
    set({ presenceFailures: failures, presenceUnavailable: failures.length > 0 })
  },
  async refresh(isCurrent = () => true) {
    if (get().busy) return
    try {
      const [session, saved] = await Promise.all([
        rpc.request<HostedSession | null>('collaboration/status'),
        rpc.request<SavedHostedProject | null>('collaboration/saved')
      ])
      if (isCurrent() && !get().busy) set({ session, saved, ...(!session ? { invitation: '' } : {}),
        ...(session?.sessionId !== get().session?.sessionId ? { presenceFailures: [], presenceUnavailable: false } : {}) })
      // Another writer compacted the shared history while this session was behind. With nothing waiting to
      // be sent, reloading from the newest checkpoint loses nothing, so do it without asking.
      if (isCurrent() && session?.mode === 'persistent' && session.connection === 'CheckpointRefreshRequired' && !session.hasPendingUpdates) {
        await get().run('end')
        if (!get().session) await get().run('persistentResume')
      }
    } catch (error) { if (isCurrent()) set({ error: String(error) }) }
  },
  // Called once per project open. Relay and persistent sessions can resume from their saved connection;
  // direct and Steam sessions cannot.
  async autoReconnect(project) {
    const { session, saved, busy } = get()
    if (session || busy || !saved || !readPreference(project).autoReconnect) return
    await get().run(saved.mode === 'persistent' ? 'persistentResume' : 'resume', [])
  },
  async run(operation, params) {
    if (get().busy) return
    set({ busy: operation, error: '', invitation: '', copied: false, transfer: null, cancelling: false })
    try {
      if (operation === 'invite') set({ invitation: await rpc.request<string>('collaboration/invite', params) })
      else if (operation === 'copy') {
        await rpc.request('collaboration/copy', params)
        set({ copied: true })
      }
      else if (operation === 'end') {
        await rpc.request('collaboration/end')
        set({ session: null, presenceFailures: [], presenceUnavailable: false, conflicts: [], conflictsOpen: false })
      } else if (operation === 'persistentCreate' || operation === 'persistentJoin' || operation === 'persistentResume') {
        const method = operation === 'persistentCreate' ? 'collaboration/persistent/create' : operation === 'persistentJoin'
          ? 'collaboration/persistent/join' : 'collaboration/persistent/resume'
        const session = await rpc.request<HostedSession>(method, params)
        set({ session, presenceFailures: [], presenceUnavailable: false, conflicts: [], conflictsOpen: false })
        // Writing done while disconnected that collides with another writer's waits for a choice.
        if (session.conflicts) await get().loadConflicts()
      } else if (operation === 'resume') {
        set({ session: await rpc.request<HostedSession>('collaboration/resume', params), presenceFailures: [], presenceUnavailable: false })
      } else if (operation === 'peerHost') {
        set({ session: await rpc.request<HostedSession>('collaboration/peer/host', params), presenceFailures: [], presenceUnavailable: false })
      } else if (operation === 'peerJoin') {
        set({ session: await rpc.request<HostedSession>('collaboration/peer/join', params), presenceFailures: [], presenceUnavailable: false })
      } else if (operation === 'steamHost') {
        set({ session: await rpc.request<HostedSession>('collaboration/steam/host', params), presenceFailures: [], presenceUnavailable: false })
      } else if (operation === 'steamJoin') {
        set({ session: await rpc.request<HostedSession>('collaboration/steam/join', params), presenceFailures: [], presenceUnavailable: false })
      } else {
        const session = operation === 'create'
          ? await rpc.request<HostedSession>('collaboration/create', params)
          : await rpc.request<HostedSession>('collaboration/join', params)
        set({ session, presenceFailures: [], presenceUnavailable: false })
      }
    } catch (error) {
      const message = String(error)
      set({ error: message, transfer: null })
      useHostBridgeStore.getState().pushToast(message)
    }
    finally { set({ busy: null, cancelling: false }) }
  }
}))
