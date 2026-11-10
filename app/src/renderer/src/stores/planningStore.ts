import { create } from 'zustand'
import { rpc } from '../rpc/client'
import { useProjectStore } from './projectStore'
import { useManuscriptStore } from './manuscriptStore'
import type { PlanningStateDto } from './planningTypes'
import { isPlanningMetadataMutation, planningMetadataNotification } from '../../../shared/planningMetadata'

export type PlanningMode = 'structure' | 'corkboard' | 'outliner' | 'board'

interface PlanningState {
  state: PlanningStateDto | null
  owner: { projectPath: string | null; workspaceEpoch: number } | null
  mode: PlanningMode
  loading: boolean
  error: string | null
  setMode(mode: PlanningMode): void
  load(): Promise<void>
  setPov(chapterGuid: string, sceneId: string, value: string): Promise<void>
  setGoalOutcome(chapterGuid: string, sceneId: string, goal: string, outcome: string): Promise<void>
}

let loadGeneration = 0

const metadataListeners = new Set<() => void>()
let observingNotifications = false

export function invalidatePlanningMetadata(): void {
  for (const changed of metadataListeners) changed()
}

export function observePlanningMetadata(changed: () => void): () => void {
  if (!observingNotifications) {
    rpc.onNotification(planningMetadataNotification, params => {
      const mutation = params as { method?: unknown } | null
      if (typeof mutation?.method === 'string' && isPlanningMetadataMutation(mutation.method)) invalidatePlanningMetadata()
    })
    observingNotifications = true
  }
  metadataListeners.add(changed)
  const unsubscribe = rpc.onRequestCompleted(method => { if (isPlanningMetadataMutation(method)) changed() })
  return () => { unsubscribe(); metadataListeners.delete(changed) }
}

export const usePlanningStore = create<PlanningState>((set, get) => ({
  state: null, owner: null, mode: 'structure', loading: false, error: null,
  setMode: mode => set({ mode }),
  load: async () => {
    const generation = ++loadGeneration
    const owner = useProjectStore.getState()
    set({ loading: true, error: null })
    try {
      const state = await rpc.request<PlanningStateDto>('planning/get')
      const current = useProjectStore.getState()
      if (generation !== loadGeneration) return
      if (current.projectPath !== owner.projectPath || current.workspaceEpoch !== owner.workspaceEpoch ||
        current.activeBookId !== state.bookId || current.activeDraftId !== state.draftId) {
        set({ state: null, loading: false })
        return
      }
      set({ state, owner: { projectPath: owner.projectPath, workspaceEpoch: owner.workspaceEpoch }, loading: false })
    } catch (error) {
      if (generation === loadGeneration) set({ loading: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },
  setPov: async (chapterGuid, sceneId, value) => {
    await useManuscriptStore.getState().setPov(chapterGuid, sceneId, value)
    await get().load()
  },
  setGoalOutcome: async (chapterGuid, sceneId, goal, outcome) => {
    await useManuscriptStore.getState().setGoalOutcome(chapterGuid, sceneId, goal, outcome)
    await get().load()
  }
}))
