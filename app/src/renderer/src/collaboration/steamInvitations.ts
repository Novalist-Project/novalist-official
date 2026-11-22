import { create } from 'zustand'
import { rpc } from '../rpc/client'
import { useHostBridgeStore } from '../stores/hostBridgeStore'
import { useProjectStore } from '../stores/projectStore'

export interface SteamJoinRequest { id: string; link: string | null; friendName: string | null; error: string | null }
interface SteamInvitationState {
  pending: SteamJoinRequest | null
  pollError: string
  refresh(): Promise<void>
  receive(connectString: string): Promise<void>
  dismiss(id: string): Promise<void>
}

function pollingWorkspace() {
  const state = useProjectStore.getState()
  return state.workspaceBusy || state.workspaceSuspended || state.workspaceRecovering || state.workspaceTransitionToken
    ? null : { epoch: state.workspaceEpoch, projectPath: state.projectPath }
}

export const useSteamInvitations = create<SteamInvitationState>((set, get) => ({
  pending: null,
  pollError: '',
  async refresh() {
    const workspace = pollingWorkspace()
    if (!workspace) return
    const isCurrent = (): boolean => {
      const current = pollingWorkspace()
      return current?.epoch === workspace.epoch && current?.projectPath === workspace.projectPath
    }
    try {
      const pending = await rpc.request<SteamJoinRequest | null>('collaboration/steam/pendingInvitation')
      if (isCurrent()) set({ pending, pollError: '' })
    } catch (error) {
      if (!isCurrent()) return
      const message = String(error)
      if (message !== get().pollError) useHostBridgeStore.getState().pushToast(message)
      set({ pollError: message })
    }
  },
  async receive(connectString) {
    await rpc.request('collaboration/steam/receiveInvitation', [connectString])
    await get().refresh()
  },
  async dismiss(id) {
    await rpc.request('collaboration/steam/dismissInvitation', [id])
    if (get().pending?.id === id) set({ pending: null })
  }
}))
