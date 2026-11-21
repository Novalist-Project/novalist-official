import { rpc } from '../rpc/client'
import { flushPendingWrites } from './pendingWrites'
import i18n from '../i18n'
import { type ChapterDateRange, type ProjectStateDto, type ProjectSlice } from './projectTypes'
import { useProjectStore, reconcileSceneEditors } from './projectStore'
import { executeWritingStructure } from './writingStructure'
import { chapterActCommand, insertChapterCommand, reorderChapterCommand } from './chapterStructureCommands'
import type { PlanningAct, PlanningStateDto } from './planningTypes'
import type { StructureCommand } from '../views/editor/writingStructureTypes'

let pendingSceneContexts = 0

export async function runSceneContext(action: () => Promise<void>): Promise<void> {
  ensureSceneStructureReady()
  pendingSceneContexts++
  try {
    await action()
  } finally {
    pendingSceneContexts--
  }
}

function ensureSceneStructureReady(): void {
  if (useProjectStore.getState().changingSceneStructure || useProjectStore.getState().workspaceBusy) {
    throw new Error(i18n.t('update.workspaceBusy'))
  }
}

async function readEmptyActOrder(act: string | undefined): Promise<readonly PlanningAct[]> {
  const owner = useProjectStore.getState()
  if (!act || owner.chapters.some(chapter => chapter.act.toLocaleLowerCase() === act.toLocaleLowerCase())) return []
  const planning = await rpc.request<PlanningStateDto>('planning/get')
  const current = useProjectStore.getState()
  if (current.workspaceBusy || current.workspaceEpoch !== owner.workspaceEpoch || current.projectPath !== owner.projectPath ||
      current.activeBookId !== owner.activeBookId || current.activeDraftId !== owner.activeDraftId) throw new Error('writing.structureWorkspaceChanged')
  return planning.acts
}

export async function prepareChapterInsertion(title: string, order?: number, act?: string, dateRange?: ChapterDateRange): Promise<StructureCommand> {
  const acts = await readEmptyActOrder(act)
  return insertChapterCommand(useProjectStore.getState().chapters, title, order, act, acts, dateRange)
}

export async function prepareChapterAct(chapterGuid: string, act: string): Promise<StructureCommand> {
  const acts = await readEmptyActOrder(act)
  return chapterActCommand(useProjectStore.getState().chapters, chapterGuid, act, acts)
}

export const createProjectSceneActions: ProjectSlice<'createChapter' | 'createScene' | 'renameChapter' | 'renameScene' | 'deleteChapter' | 'deleteScene' | 'setChapterAct' | 'reorderChapter' | 'reorderScene' | 'moveScenes' | 'mutateSceneStructure'> = (set, get) => ({
  createChapter: async (title, insertAtOrder, act, dateRange) => {
    if (!window.novalist.isMobile) {
      return executeWritingStructure(await prepareChapterInsertion(title, insertAtOrder, act, dateRange))
    }
    const state = await rpc.request<ProjectStateDto>('project/createChapter', [
      title,
      insertAtOrder ?? null
    ])
    get().applyState(state)
  },

  createScene: async (chapterGuid, title) => {
    const state = await rpc.request<ProjectStateDto>('project/createScene', [chapterGuid, title])
    get().applyState(state)
  },

  renameChapter: async (chapterGuid, title) => {
    get().applyState(
      await rpc.request<ProjectStateDto>('project/renameChapter', [chapterGuid, title])
    )
  },

  renameScene: async (chapterGuid, sceneId, title) => {
    get().applyState(
      await rpc.request<ProjectStateDto>('project/renameScene', [chapterGuid, sceneId, title])
    )
  },

  deleteChapter: async (chapterGuid) => {
    await get().mutateSceneStructure('project/deleteChapter', [chapterGuid])
  },

  deleteScene: async (chapterGuid, sceneId) => {
    await get().mutateSceneStructure('project/deleteScene', [chapterGuid, sceneId])
  },

  setChapterAct: async (chapterGuid, act) => {
    if (!window.novalist.isMobile) {
      if (get().chapters.find(chapter => chapter.guid === chapterGuid)?.act === act) return
      return executeWritingStructure(await prepareChapterAct(chapterGuid, act))
    }
    get().applyState(
      await rpc.request<ProjectStateDto>('project/setChapterAct', [chapterGuid, act])
    )
  },

  reorderChapter: async (chapterGuid, newOrder) => {
    if (!window.novalist.isMobile) return executeWritingStructure(reorderChapterCommand(get().chapters, chapterGuid, newOrder))
    get().applyState(
      await rpc.request<ProjectStateDto>('project/reorderChapter', [chapterGuid, newOrder])
    )
  },

  reorderScene: async (chapterGuid, sceneId, newOrder) => {
    if (!window.novalist.isMobile) {
      const scenes = get().chapters.find(chapter => chapter.guid === chapterGuid)?.scenes
      if (!scenes?.some(scene => scene.id === sceneId)) throw new Error('writing.structureConflict')
      const full = [...scenes].sort((a, b) => a.order - b.order)
      const index = full.findIndex(scene => scene.order === newOrder)
      if (index < 0) throw new Error('writing.structureConflict')
      return executeWritingStructure({ kind: 'moveScenes', sceneIds: [sceneId], targetChapterGuid: chapterGuid,
        beforeSceneId: full.filter(scene => scene.id !== sceneId)[index]?.id ?? null })
    }
    get().applyState(
      await rpc.request<ProjectStateDto>('project/reorderScene', [chapterGuid, sceneId, newOrder])
    )
  },

  moveScenes: async (sceneIds, targetChapterGuid, targetIndex) => {
    if (!window.novalist.isMobile) {
      const scenes = get().chapters.find(chapter => chapter.guid === targetChapterGuid)?.scenes
      if (!scenes) throw new Error('writing.structureConflict')
      const remaining = [...scenes].sort((a, b) => a.order - b.order).filter(scene => !sceneIds.includes(scene.id))
      return executeWritingStructure({ kind: 'moveScenes', sceneIds, targetChapterGuid, beforeSceneId: remaining[targetIndex]?.id ?? null })
    }
    await get().mutateSceneStructure('project/moveScenes', [sceneIds, targetChapterGuid, targetIndex])
  },

  mutateSceneStructure: async (method, args) => {
    ensureSceneStructureReady()
    if (pendingSceneContexts > 0) throw new Error(i18n.t('update.workspaceBusy'))
    set({ changingSceneStructure: true })
    try {
      // Archive/delete must capture the live prose before moving its file;
      // a moved scene must finish writes that still address its old chapter.
      await flushPendingWrites()
      await get().flushPendingSave()
      const { useManuscriptStore } = await import('./manuscriptStore')
      await useManuscriptStore.getState().flushPendingSave()
      if (get().sceneConflict || Object.values(get().dirtyMap).some(Boolean)) {
        throw new Error(i18n.t('update.sceneWriteConflict'))
      }
      const result = await rpc.request<ProjectStateDto | { state: ProjectStateDto }>(method, args)
      const state = 'state' in result ? result.state : result
      // Only retire ownership after the backend accepted the operation. A
      // failed archive leaves every tab and its prose available for retry.
      get().applyState(state)
      set((current) => reconcileSceneEditors(current, state.chapters))
      useManuscriptStore.getState().reconcileSceneStructure(state.chapters)
    } catch (error) {
      const { useHostBridgeStore } = await import('./hostBridgeStore')
      const message = error instanceof Error ? error.message : String(error)
      useHostBridgeStore.getState().pushToast(i18n.t('toast.saveFailed').replace('{0}', message))
      throw error
    } finally {
      set({ changingSceneStructure: false })
    }
  }
})
