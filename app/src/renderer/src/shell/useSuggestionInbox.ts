import { useEffect, useMemo, useState } from 'react'
import { rpc } from '../rpc/client'
import { useEditorBridge } from '../stores/editorBridgeStore'
import { useProjectStore } from '../stores/projectStore'
import type { ProjectState } from '../stores/projectTypes'
import { sceneRefKey } from '../stores/writingDocuments'
import { observeWritingSuggestionCounts } from './writingSuggestionCounts'

interface SuggestionScene {
  chapterGuid: string
  chapterTitle: string
  sceneId: string
  sceneTitle: string
  count: number
}

const contextKey = (state: ProjectState): string => JSON.stringify([
  state.projectPath, state.workspaceEpoch, state.activeBookId, state.activeDraftId,
  state.isLoaded, state.closingProject, state.workspaceBusy, state.workspaceSuspended
])

export function useSuggestionInbox() {
  const key = useProjectStore(contextKey)
  const chapters = useProjectStore(state => state.chapters)
  const revision = useEditorBridge(state => state.suggestionsRevision)
  const [loaded, setLoaded] = useState<{ key: string; rows: SuggestionScene[] } | null>(null)
  const [overlay, setOverlay] = useState<{ key: string; counts: ReadonlyMap<string, number> } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const source = useMemo(() => {
    const state = useProjectStore.getState()
    if (contextKey(state) !== key || window.novalist.isMobile || !state.isLoaded || state.closingProject || state.workspaceBusy || state.workspaceSuspended) return null
    const registry = state.getWritingRegistry()
    return registry ? { registry, activeSceneId: state.openSceneId } : null
  }, [key])

  useEffect(() => {
    const state = useProjectStore.getState()
    if (!state.isLoaded || state.closingProject || state.workspaceBusy || state.workspaceSuspended) return
    let current = true
    void rpc.request<SuggestionScene[]>('suggestions/inbox').then(rows => {
      if (current && contextKey(useProjectStore.getState()) === key) {
        setLoaded({ key, rows })
        setFailure(null)
      }
    }, reason => {
      if (current) setFailure({ key, message: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { current = false }
  }, [key, revision])

  useEffect(() => {
    if (!source) return
    return observeWritingSuggestionCounts(source.registry, source.activeSceneId, counts => {
      if (contextKey(useProjectStore.getState()) === key) setOverlay({ key, counts })
    })
  }, [source, key])

  const scenes = useMemo(() => {
    const rows = loaded?.key === key ? loaded.rows : []
    if (!source || overlay?.key !== key) return rows
    const byScene = new Map(rows.map(row => [row.sceneId, row]))
    const { bookId, draftId } = source.registry.context
    return chapters.flatMap(chapter => chapter.scenes.flatMap(scene => {
      const count = overlay.counts.get(sceneRefKey({ bookId, draftId, chapterGuid: chapter.guid, sceneId: scene.id })) ?? byScene.get(scene.id)?.count ?? 0
      return count ? [{ chapterGuid: chapter.guid, chapterTitle: chapter.title, sceneId: scene.id, sceneTitle: scene.title, count }] : []
    }))
  }, [loaded, source, overlay, chapters, key])
  return { scenes, error: failure?.key === key ? failure.message : null }
}
