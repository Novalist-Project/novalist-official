import { findSharedWritingSession, getSharedWritingSession, observeSharedWritingSession } from '../collaboration/sharedWritingSessions'
import type { SharedSceneSession } from '../collaboration/SharedSceneSession'
import type { ProjectState } from '../stores/projectTypes'

export function writingSceneContextSource(getState: () => ProjectState, chapterGuid: string | null, sceneId: string | null) {
  const state = getState()
  const enabled = !window.novalist.isMobile && state.isLoaded && !state.closingProject &&
    !state.workspaceSuspended && !state.workspaceBusy && chapterGuid === state.openChapterGuid && sceneId === state.openSceneId
  const registry = enabled && chapterGuid && sceneId ? state.getWritingRegistry() : null
  const ref = registry && chapterGuid && sceneId
    ? { bookId: registry.context.bookId, draftId: registry.context.draftId, chapterGuid, sceneId } : null
  const current = (): boolean => {
    const latest = getState()
    return !!registry && !registry.isClosed && latest.isLoaded && !latest.closingProject &&
      !latest.workspaceBusy && !latest.workspaceSuspended && latest.projectPath === state.projectPath &&
      latest.workspaceEpoch === state.workspaceEpoch && latest.activeBookId === state.activeBookId &&
      latest.activeDraftId === state.activeDraftId && latest.openChapterGuid === chapterGuid && latest.openSceneId === sceneId
  }
  return {
    read(): string | null | undefined {
      if (window.novalist.isMobile) return undefined
      const snapshot = registry && ref && current() ? registry.getSnapshot(ref) : undefined
      if (!snapshot) return null
      const owner = snapshot.shared ? findSharedWritingSession(snapshot.shared) : undefined
      return owner && !owner.isClosed ? owner.html : snapshot.html
    },
    subscribe(changed: () => void): () => void {
      if (!registry || !ref || !current()) return () => undefined
      let owner: SharedSceneSession | undefined
      let unsubscribeShared: (() => void) | undefined
      const unsubscribe = registry.subscribe(ref, snapshot => {
        const next = snapshot.shared ? getSharedWritingSession(snapshot.shared) : undefined
        if (next !== owner) {
          unsubscribeShared?.()
          owner = next
          unsubscribeShared = snapshot.shared ? observeSharedWritingSession(snapshot.shared, changed) : undefined
        }
        changed()
      })
      return () => { unsubscribe(); unsubscribeShared?.() }
    }
  }
}
