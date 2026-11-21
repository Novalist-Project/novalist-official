import { useRef, type RefObject } from 'react'
import { rpc } from '../../rpc/client'
import { editorPane, useProjectStore } from '../../stores/projectStore'
import { useEditorBridge } from '../../stores/editorBridgeStore'
import type { EditorWindow } from './editorBridge'
import type { WritingFrameAdapter } from './writingFrameAdapter'
import type { WritingComment } from './writingTypes'

type SceneComment = WritingComment

interface SceneFootnote {
  id: string
  number: number
  text: string
}

interface Annotations {
  comments: SceneComment[]
  footnotes: SceneFootnote[]
}

function pushAnnotations(editor: EditorWindow, annotations: Annotations): void {
  editor.setCommentsData(annotations.comments.map(({ id, anchorText, text }) => ({ id, anchorText, text })))
  editor.setFootnotesData(annotations.footnotes.map(({ id, text }) => ({ id, text })))
}

export function useEditorAnnotations(pane: string, editorRef: RefObject<EditorWindow | null>, writing?: WritingFrameAdapter) {
  const annotationsRef = useRef<Annotations>({ comments: [], footnotes: [] })
  const ownAnnotationsRef = useRef(0)
  const annotationsLoadRef = useRef(0)
  const paneIds = (): { chapterGuid: string | null; sceneId: string | null } => {
    const editor = editorPane(useProjectStore.getState(), pane)
    return { chapterGuid: editor.chapterGuid, sceneId: editor.sceneId }
  }

  const loadAnnotations = async (editor: EditorWindow | null): Promise<boolean> => {
    const { chapterGuid, sceneId } = paneIds()
    if (!chapterGuid || !sceneId) return false
    const request = ++annotationsLoadRef.current
    const annotations = writing ? writing.readAnnotations() : await rpc.request<Annotations>('scenes/getAnnotations', [chapterGuid, sceneId])
    if (!annotations) return false
    const current = paneIds()
    // Reads must not replace annotations from a later scene or local edit.
    if (request !== annotationsLoadRef.current || current.chapterGuid !== chapterGuid ||
        current.sceneId !== sceneId || editor !== editorRef.current) return false
    annotationsRef.current = annotations
    if (editor) pushAnnotations(editor, annotations)
    return true
  }

  const persistAnnotations = (): Promise<void> => {
    annotationsLoadRef.current++
    if (writing) {
      writing.writeAnnotations(annotationsRef.current)
      return Promise.resolve()
    }
    const { chapterGuid, sceneId } = paneIds()
    if (!chapterGuid || !sceneId) return Promise.resolve()
    const { comments, footnotes } = annotationsRef.current
    return rpc.request('scenes/setAnnotations', [chapterGuid, sceneId, comments, footnotes])
      .then(() => {
        useEditorBridge.getState().annotationsChanged()
        ownAnnotationsRef.current = useEditorBridge.getState().annotationsRevision
      })
      .catch(() => undefined)
  }

  const applyFootnoteOrder = (ids: string[]): void => {
    const stored = annotationsRef.current.footnotes
    const known = new Map(stored.map((footnote) => [footnote.id, footnote]))
    const ordered = ids.map((id, index) => ({
      ...(known.get(id) ?? { id, text: '' }), number: index + 1
    }))
    const same = ordered.length === stored.length &&
      ordered.every((footnote, index) => stored[index].id === footnote.id && stored[index].number === footnote.number)
    annotationsRef.current.footnotes = ordered
    if (!same) void persistAnnotations()
  }
  return {
    annotationsRef, ownAnnotationsRef, paneIds, loadAnnotations, persistAnnotations, applyFootnoteOrder,
    pushAnnotations: (editor: EditorWindow): void => pushAnnotations(editor, annotationsRef.current)
  }
}

export type EditorAnnotations = ReturnType<typeof useEditorAnnotations>
