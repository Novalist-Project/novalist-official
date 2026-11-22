import { useEffect, useMemo, useState } from 'react'
import { rpc } from '../rpc/client'
import { useEditorBridge } from '../stores/editorBridgeStore'
import { useProjectStore } from '../stores/projectStore'
import type { ProjectState } from '../stores/projectTypes'
import { useSettingsStore } from '../stores/settingsStore'
import { editWritingAnnotations } from '../stores/writingAnnotationEdits'
import { sceneRefKey } from '../stores/writingDocuments'
import { getWritingNavigation } from '../views/editor/writingNavigation'
import type { SceneRef, WritingComment } from '../views/editor/writingTypes'
import { changeInboxComment, type InboxAction, type InboxItem } from './inboxComments'

const contextKey = (state: ProjectState): string => JSON.stringify([
  state.projectPath, state.workspaceEpoch, state.activeBookId, state.activeDraftId,
  state.isLoaded, state.closingProject, state.workspaceBusy, state.workspaceSuspended
])
const available = (state: ProjectState): boolean => state.isLoaded && !state.closingProject && !state.workspaceBusy && !state.workspaceSuspended

async function changeMobileComment(item: InboxItem, action: InboxAction): Promise<void> {
  const args = [item.sceneId, item.commentId]
  if (action.kind === 'todo') await rpc.request('inbox/setTodo', [...args, action.value])
  if (action.kind === 'resolved') await rpc.request('inbox/setResolved', [...args, action.value])
  if (action.kind === 'verdict') await rpc.request('inbox/setVerdict', [...args, action.value])
  if (action.kind === 'reply') await rpc.request('inbox/reply', [...args, action.text.trim()])
}

export function useCommentInbox(showResolved: boolean) {
  const key = useProjectStore(contextKey)
  const chapters = useProjectStore(state => state.chapters)
  const annotationRevision = useEditorBridge(state => state.annotationsRevision)
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; items: InboxItem[] } | null>(null)
  const [overlay, setOverlay] = useState<{ key: string; comments: ReadonlyMap<string, WritingComment[]> } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const source = useMemo(() => {
    const state = useProjectStore.getState()
    return contextKey(state) === key && available(state) && !window.novalist.isMobile ? state.getWritingRegistry() : null
  }, [key])

  useEffect(() => {
    if (!available(useProjectStore.getState())) return
    let current = true
    void rpc.request<InboxItem[]>('inbox/list', [showResolved]).then(items => {
      if (current && contextKey(useProjectStore.getState()) === key) { setLoaded({ key, items }); setFailure(null) }
    }, reason => { if (current) setFailure({ key, message: String(reason) }) })
    return () => { current = false }
  }, [key, showResolved, annotationRevision, revision])

  useEffect(() => {
    if (!source) return
    const comments = new Map<string, WritingComment[]>(), versions = new Map<string, string>()
    const update = (ref: SceneRef | null): void => {
      if (!ref || source.isClosed || contextKey(useProjectStore.getState()) !== key) return
      const annotations = source.getAnnotations(ref)
      if (!annotations) return
      const id = sceneRefKey(ref), version = JSON.stringify(annotations.comments)
      if (versions.get(id) === version) return
      versions.set(id, version); comments.set(id, annotations.comments)
      setOverlay({ key, comments: new Map(comments) })
    }
    const release = source.observeScenes(update)
    for (const snapshot of source.capture()) update(snapshot)
    return release
  }, [source, key])

  const items = useMemo(() => {
    const disk = loaded?.key === key ? loaded.items : []
    if (!source || overlay?.key !== key) return disk
    const rows = new Map<string, InboxItem[]>()
    for (const item of disk) {
      const id = sceneRefKey({ ...source.context, ...item })
      rows.set(id, [...rows.get(id) ?? [], item])
    }
    return chapters.flatMap(chapter => chapter.scenes.flatMap(scene => {
      const id = sceneRefKey({ ...source.context, chapterGuid: chapter.guid, sceneId: scene.id })
      const comments = overlay.comments.get(id)
      if (!comments) return rows.get(id) ?? []
      return comments.filter(comment => showResolved || !comment.resolved).map(comment => ({
        chapterGuid: chapter.guid, chapterTitle: chapter.title, sceneId: scene.id, sceneTitle: scene.title,
        commentId: comment.id, anchorText: comment.anchorText, text: comment.text, author: comment.author ?? '',
        isTodo: comment.isTodo ?? false, resolved: comment.resolved, createdAt: comment.createdAt ?? '',
        replies: comment.replies ?? [], verdict: comment.verdict ?? ''
      }))
    }))
  }, [loaded, source, overlay, chapters, showResolved, key])

  const change = async (item: InboxItem, action: InboxAction): Promise<boolean> => {
    try {
      const state = useProjectStore.getState()
      if (contextKey(state) !== key || !available(state)) throw new Error('writing.annotationSceneUnavailable')
      if (window.novalist.isMobile) { await changeMobileComment(item, action); setRevision(value => value + 1) }
      else {
        if (!source) throw new Error('writing.annotationSceneUnavailable')
        const ref = { bookId: source.context.bookId, draftId: source.context.draftId, chapterGuid: item.chapterGuid, sceneId: item.sceneId }
        if (!state.chapters.some(chapter => chapter.guid === ref.chapterGuid && chapter.scenes.some(scene => scene.id === ref.sceneId)))
          throw new Error('writing.annotationSceneUnavailable')
        await source.read(ref)
        const current = useProjectStore.getState()
        if (contextKey(current) !== key) throw new Error('writing.annotationSceneUnavailable')
        const surface = current.activeEditorPaneId ? getWritingNavigation(current.activeEditorPaneId) : null
        editWritingAnnotations(source, ref, annotations => {
          const comment = annotations.comments.find(value => value.id === item.commentId)
          if (!comment) throw new Error('writing.annotationsUnavailable')
          changeInboxComment(comment, action, useSettingsStore.getState().view?.project?.author ?? '')
          return annotations
        }, surface)
      }
      setFailure(null)
      return true
    } catch (reason) { setFailure({ key, message: String(reason) }); return false }
  }
  return { items, change, error: failure?.key === key ? failure.message : null }
}
