import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { rpc } from '../../rpc/client'
import { SceneNotesDocument } from '../../shell/sceneNotesDocument'
import { registerPendingWrite, retainPendingWrite } from '../../stores/pendingWrites'
import { usePlanningStore } from '../../stores/planningStore'
import { useProjectStore } from '../../stores/projectStore'
import type { PlanningChapter } from '../../stores/planningTypes'

interface ChapterSummarySession { document: SceneNotesDocument; mounted: number; metadata: string }
const sessions = new Map<string, ChapterSummarySession>()

export function useChapterSummaryDocument(chapter: PlanningChapter) {
  const projectPath = useProjectStore(state => state.projectPath)
  const bookId = useProjectStore(state => state.activeBookId)
  const draftId = useProjectStore(state => state.activeDraftId)
  const chapterGuid = chapter.guid
  // Recovery changes transport epochs, but retains the authored chapter document.
  const key = JSON.stringify(['chapter-summary', projectPath, bookId, draftId, chapterGuid])
  const session = useMemo(() => {
    const existing = sessions.get(key)
    if (existing) return existing
    const ownsWorkspace = (): boolean => {
      const current = useProjectStore.getState()
      return current.projectPath === projectPath && current.activeBookId === bookId && current.activeDraftId === draftId &&
        current.chapters.some(item => item.guid === chapterGuid)
    }
    const created: ChapterSummarySession = { document: new SceneNotesDocument(
      async () => created.metadata,
      async text => {
        if (!ownsWorkspace()) throw new Error('The chapter workspace changed. Reopen its summary before saving.')
        await rpc.request('project/setChapterDescription', [chapterGuid, text])
        created.metadata = text
        if (!ownsWorkspace()) return
        useProjectStore.setState(state => ({ chapters: state.chapters.map(item => item.guid === chapterGuid ? { ...item, description: text } : item) }))
        usePlanningStore.setState(state => state.state?.bookId === bookId && state.state.draftId === draftId && state.owner?.projectPath === projectPath
          ? { state: { ...state.state, chapters: state.state.chapters.map(item => item.guid === chapterGuid ? { ...item, description: text } : item) } }
          : {})
      }
    ), mounted: 0, metadata: chapter.description ?? '' }
    sessions.set(key, created)
    return created
  }, [key, projectPath, bookId, draftId, chapterGuid, chapter.description])
  const { document } = session
  const state = useSyncExternalStore(document.subscribe, document.snapshot)

  useEffect(() => {
    session.mounted++
    sessions.set(key, session)
    const unregister = registerPendingWrite(() => document.flush())
    if (!document.state.loaded) void document.load()
    const release = (): void => {
      if (!session.mounted && sessions.get(key) === session) { sessions.delete(key); document.dispose() }
    }
    return () => {
      unregister()
      if (--session.mounted) return
      document.cancelLoad()
      if (document.dirty) retainPendingWrite(key, async () => { await document.flush(); release() })
      else release()
    }
  }, [document, key, session])

  const previousMetadata = useRef(chapter.description)
  useEffect(() => {
    const changed = previousMetadata.current !== chapter.description
    previousMetadata.current = chapter.description
    if (!changed || document.dirty) return
    session.metadata = chapter.description ?? ''
    void document.load()
  }, [chapter.description, document, session])

  return { document, state }
}
