import { useEffect, useMemo, useState } from 'react'
import { rpc } from '../rpc/client'
import { useEditorBridge } from '../stores/editorBridgeStore'
import { useProjectStore } from '../stores/projectStore'
import type { ProjectState } from '../stores/projectTypes'
import { getWritingNavigation } from '../views/editor/writingNavigation'
import { removeWritingAnnotation } from '../views/editor/writingAnnotationRemoval'
import type { WritingAnnotations } from '../views/editor/writingTypes'

const emptyAnnotations = (): WritingAnnotations => ({ comments: [], footnotes: [] })
const contextKey = (state: ProjectState): string => JSON.stringify([
  state.projectPath, state.workspaceEpoch, state.activeBookId, state.activeDraftId,
  state.isLoaded, state.closingProject, state.workspaceBusy, state.workspaceSuspended,
  state.openChapterGuid, state.openSceneId
])

export function useSceneAnnotations(chapterGuid: string, sceneId: string) {
  const [loaded, setLoaded] = useState<{ key: string; value: WritingAnnotations } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const key = useProjectStore(contextKey)
  const revision = useEditorBridge(state => state.annotationsRevision)
  const source = useMemo(() => {
    const state = useProjectStore.getState()
    if (contextKey(state) !== key || window.novalist.isMobile || !state.isLoaded || state.closingProject || state.workspaceBusy ||
        state.workspaceSuspended || state.openChapterGuid !== chapterGuid || state.openSceneId !== sceneId) return null
    const registry = state.getWritingRegistry()
    return registry ? { registry, ref: { bookId: registry.context.bookId, draftId: registry.context.draftId, chapterGuid, sceneId } } : null
  }, [chapterGuid, sceneId, key])

  useEffect(() => {
    let current = true
    if (source) {
      const update = (): void => {
        if (current && contextKey(useProjectStore.getState()) === key)
          setLoaded({ key, value: source.registry.getAnnotations(source.ref) ?? emptyAnnotations() })
      }
      const unsubscribe = source.registry.subscribe(source.ref, update)
      return () => { current = false; unsubscribe() }
    }
    if (window.novalist.isMobile) {
      void rpc.request<WritingAnnotations>('scenes/getAnnotations', [chapterGuid, sceneId]).then(value => {
        if (current) setLoaded({ key, value })
      }, reason => { if (current) setFailure({ key, message: String(reason) }) })
    }
    return () => { current = false }
  }, [chapterGuid, sceneId, source, key, revision])

  const activeSurface = () => {
    const state = useProjectStore.getState()
    const surface = state.activeEditorPaneId && getWritingNavigation(state.activeEditorPaneId)
    if (contextKey(state) !== key || !source || !surface || surface.context !== source.registry.context)
      throw new Error('writing.annotationSceneUnavailable')
    return { surface, ref: source.ref }
  }
  const persist = async (comments: WritingAnnotations['comments'], footnotes: WritingAnnotations['footnotes']): Promise<boolean> => {
    try {
      if (contextKey(useProjectStore.getState()) !== key) throw new Error('writing.annotationSceneUnavailable')
      if (window.novalist.isMobile) {
        await rpc.request('scenes/setAnnotations', [chapterGuid, sceneId, comments, footnotes])
        useEditorBridge.getState().annotationsChanged()
      } else {
        const { surface, ref } = activeSurface()
        surface.writeSceneAnnotations(ref, { comments, footnotes })
      }
      setFailure(null)
      return true
    } catch (reason) { setFailure({ key, message: String(reason) }); return false }
  }
  const annotations = loaded?.key === key ? loaded.value : emptyAnnotations()
  const remove = async (kind: 'footnote' | 'comment', id: string): Promise<void> => {
    try {
      if (window.novalist.isMobile) {
        const comments = annotations.comments.filter(comment => kind !== 'comment' || comment.id !== id)
        const footnotes = annotations.footnotes.filter(note => kind !== 'footnote' || note.id !== id)
        if (!await persist(comments, footnotes)) return
        const bridge = useEditorBridge.getState()
        if (bridge.isShowing(sceneId)) {
          if (kind === 'footnote') bridge.editor?.removeFootnoteById(id)
          else bridge.editor?.removeCommentById(id)
        }
      } else {
        const { surface, ref } = activeSurface()
        surface.transformScene(ref, (html, current) => removeWritingAnnotation(html, current, kind, id))
      }
      setFailure(null)
    } catch (reason) { setFailure({ key, message: String(reason) }) }
  }
  return { ...annotations, error: failure?.key === key ? failure.message : null, persist, remove,
    setComments: (comments: WritingAnnotations['comments']): void => setLoaded({ key, value: { ...annotations, comments } }),
    setFootnotes: (footnotes: WritingAnnotations['footnotes']): void => setLoaded({ key, value: { ...annotations, footnotes } }) }
}
