import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { InputDialog } from '../../shell/InputDialog'
import { useProjectStore } from '../../stores/projectStore'
import { useShellStore } from '../../stores/shellStore'
import { executeWritingStructure, retryWritingStructure, useWritingStructureStatus } from '../../stores/writingStructure'
import { editorWindow } from './editorBridge'
import { getWritingNavigation } from './writingNavigation'
import type { WritingStructureRequest } from './writingPaneController'
import type { StructureCommand } from './writingStructureTypes'
import type { WritingContext, WritingSelection } from './writingTypes'
import { writingErrorMessage } from './writingError'

interface StructurePrompt {
  context: WritingContext
  paneId: string
  actName: string | null
  selection: WritingSelection | null
  sceneNumber?: number
  create(title: string): StructureCommand
}

function preparePrompt(request: WritingStructureRequest, paneId: string): StructurePrompt {
  const project = useProjectStore.getState()
  const owner = project.getWritingRegistry()
  if (!owner) throw new Error('writing.workspaceUnavailable')
  const context = owner.context
  const chapters = [...project.chapters].sort((a, b) => a.order - b.order)
  const surface = getWritingNavigation(paneId)
  surface?.capture()
  if (request.command === 'insertScene') {
    const destination = request.sceneDestination
    const chapter = chapters.find(value => value.guid === destination?.chapterGuid)
    if (!destination || !chapter || destination.beforeSceneId !== null && !chapter.scenes.some(scene => scene.id === destination.beforeSceneId)) {
      throw new Error('writing.sceneUnavailable')
    }
    return { context, paneId, actName: chapter.act || null, selection: request.selection, sceneNumber: chapter.scenes.length + 1,
      create: title => ({ kind: 'insertScene', title, ...destination }) }
  }
  if (request.command === 'insertChapter') {
    const chapterIndex = chapters.findIndex(chapter => chapter.guid === request.anchor?.chapterGuid)
    const preceding = chapterIndex < 0 ? chapters.at(-1) : chapters[chapterIndex - 1] ?? chapters[chapterIndex]
    const actName = request.destination ? request.destination.actName : preceding?.act || null
    return { context, paneId, actName, selection: request.selection, create: title => ({ kind: 'insertChapter', title,
      beforeChapterGuid: request.destination ? request.destination.beforeChapterGuid : request.anchor?.chapterGuid ?? null, actName }) }
  }
  if (!surface || !request.selection || !request.anchor) throw new Error('writing.sceneUnavailable')
  if (request.selection.anchor.sceneId !== request.selection.focus.sceneId || request.selection.anchor.offset !== request.selection.focus.offset) {
    throw new Error('writing.structureCaret')
  }
  const frame = document.querySelector<HTMLIFrameElement>(`[data-writing-pane="${CSS.escape(paneId)}"] iframe`)
  const editor = frame && editorWindow(frame)
  if (!editor) throw new Error('writing.sceneUnavailable')
  const split = editor.captureWritingSplit(request.selection.focus)
  const snapshot = owner.getSnapshot(request.anchor)
  if (!snapshot) throw new Error('writing.sceneUnavailable')
  const base = { ref: request.anchor, ...split, expectedHash: snapshot.hash }
  return { context, paneId, actName: chapters.find(chapter => chapter.guid === request.anchor?.chapterGuid)?.act || null,
    selection: request.selection, create: title => request.command === 'sceneBreak' ? { kind: 'splitScene', ...base } : { kind: 'splitChapter', title, ...base } }
}

export function WritingStructureHost(): React.JSX.Element {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState<StructurePrompt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const status = useWritingStructureStatus()
  const run = async (prepared: StructurePrompt, title: string): Promise<void> => {
    flushSync(() => { setPrompt(null); setError(null) })
    try {
      const current = useProjectStore.getState()
      if (current.projectPath !== prepared.context.workspaceId || current.workspaceEpoch !== prepared.context.workspaceEpoch ||
          current.activeBookId !== prepared.context.bookId || current.activeDraftId !== prepared.context.draftId) throw new Error('writing.structureWorkspaceChanged')
      await executeWritingStructure(prepared.create(title), prepared.selection)
      const project = useProjectStore.getState()
      if (project.openChapterGuid && project.openSceneId) await project.openSceneIn(prepared.paneId, project.openChapterGuid, project.openSceneId)
    } catch (reason) { setError(String(reason)) }
  }
  useEffect(() => {
    const receive = (event: Event): void => {
      const request = (event as CustomEvent<WritingStructureRequest & { paneId?: string }>).detail
      try {
        const prepared = preparePrompt(request, request.paneId ?? useShellStore.getState().activePaneId)
        if (request.command === 'sceneBreak' || request.command === 'insertScene') void run(prepared, prepared.sceneNumber ? t('writing.sceneName', { number: prepared.sceneNumber }) : '')
        else setPrompt(prepared)
      } catch (reason) { setError(String(reason)) }
    }
    window.addEventListener('novalist:writing-structure', receive)
    return () => window.removeEventListener('novalist:writing-structure', receive)
  }, [])
  return <>
    {prompt && <InputDialog title={`${t('unifiedWriting.insertChapter')} · ${prompt.actName ?? t('structure.unassigned')}`}
      onCancel={() => setPrompt(null)} onSubmit={title => void run(prompt, title)} />}
    {(error || status.error) && <div role="alert" className="writing-structure-error"><span>{writingErrorMessage(error ?? status.error!)}</span>
      {status.pending ? <button type="button" disabled={status.busy} onClick={() => void retryWritingStructure().then(() => setError(null)).catch(reason => setError(String(reason)))}>{t('shell.retry')}</button>
        : <button type="button" onClick={() => { setError(null); useWritingStructureStatus.setState({ error: null }) }}>{t('dialog.close')}</button>}
    </div>}
  </>
}
