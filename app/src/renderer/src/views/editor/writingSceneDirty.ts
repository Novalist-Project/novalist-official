import { findSharedWritingSession, observeSharedWritingSession } from '../../collaboration/sharedWritingSessions'
import { findSharedWritingAnnotations } from '../../collaboration/sharedWritingAnnotations'
import type { ProjectState } from '../../stores/projectTypes'
import type { SharedSceneIdentity } from '../../../../shared/sharedScene'

export function writingSceneDirtyIdentity(state: ProjectState): string {
  return JSON.stringify([state.projectPath, state.workspaceEpoch, state.activeBookId, state.activeDraftId,
    state.isLoaded, state.closingProject, state.workspaceBusy, state.workspaceSuspended])
}

export function writingSceneDirtySource(getState: () => ProjectState, chapterGuid: string, sceneId: string, identity: string) {
  const state = getState()
  const enabled = writingSceneDirtyIdentity(state) === identity && !window.novalist.isMobile && state.isLoaded && !state.closingProject &&
    !state.workspaceBusy && !state.workspaceSuspended
  const registry = enabled ? state.getWritingRegistry() : null
  const ref = registry ? { bookId: registry.context.bookId, draftId: registry.context.draftId, chapterGuid, sceneId } : null
  const current = (): boolean => {
    const latest = getState()
    return !!registry && !registry.isClosed && writingSceneDirtyIdentity(latest) === identity
  }
  return {
    read(): boolean {
      if (!registry || !ref || !current()) return false
      const shared = registry.getSnapshot(ref)?.shared
      return registry.isSceneDirty(ref) || !!(shared && (findSharedWritingSession(shared)?.dirty || findSharedWritingAnnotations(registry)?.isSceneDirty(ref)))
    },
    subscribe(changed: () => void): () => void {
      if (!registry || !ref || !current()) return () => undefined
      let shared: SharedSceneIdentity | undefined
      let unsubscribeShared: (() => void) | undefined
      const unsubscribe = registry.subscribe(ref, snapshot => {
        const next = snapshot.shared ?? undefined
        if (next?.sessionId !== shared?.sessionId || next?.itemId !== shared?.itemId) {
          unsubscribeShared?.()
          shared = next
          unsubscribeShared = shared ? observeSharedWritingSession(shared, changed) : undefined
        }
        changed()
      })
      const unsubscribeDirty = registry.subscribeDirty(ref, changed)
      return () => { unsubscribe(); unsubscribeDirty(); unsubscribeShared?.() }
    }
  }
}
