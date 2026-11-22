import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { rpc } from '../rpc/client'
import { useEditorBridge } from '../stores/editorBridgeStore'
import { useProjectStore, type ProjectStateDto } from '../stores/projectStore'
import type { ProjectState } from '../stores/projectTypes'
import { getWritingNavigation } from '../views/editor/writingNavigation'
import { writingSceneContextSource } from './writingSceneContext'
import { listTrackedSuggestions, resolveTrackedSuggestions, type TrackedSuggestion } from './trackedSuggestions'

const contextKey = (state: ProjectState): string => JSON.stringify([
  state.projectPath, state.workspaceEpoch, state.activeBookId, state.activeDraftId,
  state.isLoaded, state.closingProject, state.workspaceBusy, state.workspaceSuspended,
  state.openChapterGuid, state.openSceneId
])

const reviewMethods = {
  accept: { one: 'suggestions/accept', all: 'suggestions/acceptAll' },
  reject: { one: 'suggestions/reject', all: 'suggestions/rejectAll' }
} as const

export function useSceneSuggestions(chapterGuid: string, sceneId: string) {
  const key = useProjectStore(contextKey)
  const revision = useEditorBridge(state => state.suggestionsRevision)
  const [loaded, setLoaded] = useState<{ key: string; suggestions: TrackedSuggestion[] } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const source = useMemo(() => writingSceneContextSource(() => {
    const state = useProjectStore.getState()
    return contextKey(state) === key ? state : { ...state, workspaceBusy: true }
  }, chapterGuid, sceneId),
    [chapterGuid, sceneId, key])
  const html = useSyncExternalStore(source.subscribe, source.read)
  const live = useMemo(() => html == null ? [] : listTrackedSuggestions(html), [html])

  useEffect(() => {
    if (!window.novalist.isMobile) return
    let current = true
    void rpc.request<TrackedSuggestion[]>('suggestions/forScene', [chapterGuid, sceneId]).then(suggestions => {
      if (current) setLoaded({ key, suggestions })
    }, reason => { if (current) setFailure({ key, message: String(reason) }) })
    return () => { current = false }
  }, [chapterGuid, sceneId, key, revision])

  const answer = async (accept: boolean, id?: string): Promise<void> => {
    try {
      const state = useProjectStore.getState()
      if (contextKey(state) !== key) throw new Error('writing.documentUnavailable')
      if (window.novalist.isMobile) {
        const method = reviewMethods[accept ? 'accept' : 'reject'][id === undefined ? 'all' : 'one']
        setLoaded({ key, suggestions: await rpc.request<TrackedSuggestion[]>(method,
          id === undefined ? [chapterGuid, sceneId] : [chapterGuid, sceneId, id]) })
        await state.flushPendingSave()
        state.applyState(await rpc.request<ProjectStateDto>('project/getState'))
        await state.openScene(chapterGuid, sceneId)
      } else {
        if (source.read() == null) throw new Error('writing.documentUnavailable')
        const registry = state.getWritingRegistry()
        const surface = state.activeEditorPaneId && getWritingNavigation(state.activeEditorPaneId)
        if (!registry || !surface || surface.context !== registry.context)
          throw new Error('writing.documentUnavailable')
        surface.transformScene({ bookId: registry.context.bookId, draftId: registry.context.draftId, chapterGuid, sceneId },
          html => ({ html: resolveTrackedSuggestions(html, accept, id) }))
      }
      useEditorBridge.getState().suggestionsChanged()
      setFailure(null)
    } catch (reason) { setFailure({ key, message: reason instanceof Error ? reason.message : String(reason) }) }
  }
  return { suggestions: window.novalist.isMobile ? loaded?.key === key ? loaded.suggestions : [] : live,
    error: failure?.key === key ? failure.message : null, answer }
}
