import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { WritingSceneMargin } from './WritingSceneMargin'
import { useWritingChromeTargets } from './useWritingCanvas'
import { synopsisExpanded, setSynopsisExpanded } from './writingPresentation'
import { executeWritingStructure } from '../../stores/writingStructure'
import type { ChapterDto } from '../../stores/projectTypes'
import type { WritingDocumentRegistry } from '../../stores/writingDocuments'
import type { EditorWindow } from './editorBridge'
import type { SceneRef, SceneSnapshot, WritingScope } from './writingTypes'
import type { WritingStructureRequest } from './writingPaneController'
import { useStageStore } from '../../stores/stageStore'
import { useProjectStore } from '../../stores/projectStore'
import { WritingMetadataName } from './WritingMetadataName'
import { WritingBoundaryActions } from './WritingBoundaryActions'
import { writingBoundaryRequests } from './writingBoundaryRequests'

interface WritingCanvasChromeProps {
  live: EditorWindow | null
  registry: WritingDocumentRegistry | null
  snapshots: SceneSnapshot[]
  chapters: ChapterDto[]
  scope: WritingScope
  anchorChapter: string | undefined
  revision: number
  limited: boolean
  narrow: boolean
  showSynopsis: boolean
  bookTitle: string
  draftName: string
  activeSceneId?: string
  onFocusScene(scene: SceneRef): void
  onStructure(request: WritingStructureRequest): void
}

export const WritingCanvasChrome = memo(function WritingCanvasChrome({ live, registry, snapshots, chapters,
  scope, anchorChapter, revision, limited, narrow, showSynopsis, onStructure, bookTitle, draftName, activeSceneId, onFocusScene }: WritingCanvasChromeProps) {
  const { t } = useTranslation()
  const chapterOrder = useMemo(() => [...chapters].sort((left, right) => left.order - right.order), [chapters])
  const { targets, emptyTargets, endTarget, introTarget } = useWritingChromeTargets(live, snapshots, chapterOrder, scope, anchorChapter, revision, !limited)
  const boundaries = useMemo(() => writingBoundaryRequests(chapterOrder, snapshots, scope, anchorChapter, limited),
    [chapterOrder, snapshots, scope, anchorChapter, limited])
  const stages = useStageStore(state => state.stages)
  useEffect(() => {
    const root = activeSceneId ? live?.getWritingSceneRoot(activeSceneId) : null
    root?.setAttribute('data-writing-active', 'true')
    root?.previousElementSibling?.setAttribute('data-writing-active', 'true')
    return () => { root?.removeAttribute('data-writing-active'); root?.previousElementSibling?.removeAttribute('data-writing-active') }
  }, [live, activeSceneId, targets])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (registry) setExpanded(new Set(snapshots.filter(scene => synopsisExpanded(registry.context, scene)).map(scene => scene.sceneId)))
  }, [registry, snapshots])
  const toggleExpanded = useCallback((scene: SceneRef, value: boolean): void => {
    if (!registry) return
    setSynopsisExpanded(registry.context, scene, value)
    setExpanded(current => {
      const next = new Set(current)
      if (value) next.add(scene.sceneId)
      else next.delete(scene.sceneId)
      return next
    })
  }, [registry])
  const insertBefore = (beforeChapterGuid: string | null, actName: string | null): void => onStructure({ command: 'insertChapter', selection: null, anchor: null, destination: { beforeChapterGuid, actName } })
  return <>
    {introTarget && createPortal(<header className="writing-book-heading">
      <h1 dir="auto">{bookTitle}</h1>
      {draftName && <p dir="auto">{draftName}</p>}
    </header>, introTarget)}
    {targets.map(({ scene, element }, index) => {
      const chapter = chapters.find(value => value.guid === scene.chapterGuid)
      const metadata = chapter?.scenes.find(value => value.id === scene.sceneId)
      const startsChapter = index === 0 || targets[index - 1].scene.chapterGuid !== scene.chapterGuid
      const boundary = boundaries.before.get(scene.sceneId)
      return createPortal(<>
        {boundary && <WritingBoundaryActions requests={boundary} onStructure={onStructure} />}
        {startsChapter && chapter && !chapter.hideHeading && <header className="writing-chapter-heading">
          {registry && chapter.act && <div className="writing-act-name"><WritingMetadataName structural value={chapter.act} label={t('structure.renameAct')}
            context={registry.context} save={newName => executeWritingStructure({ kind: 'renameAct', oldName: chapter.act, newName })} /></div>}
          <span className="writing-eyebrow">{t('unifiedWriting.chapterNumber', { number: String(chapterOrder.indexOf(chapter) + 1).padStart(2, '0') })}</span>
          <h2>{registry ? <WritingMetadataName value={chapter.title} label={t('dialog.chapterName')} context={registry.context}
            save={title => useProjectStore.getState().renameChapter(chapter.guid, title)} /> : chapter.title}</h2>
          {(chapter.description || chapter.subtitle) && <p dir="auto">{chapter.description || chapter.subtitle}</p>}
        </header>}
        {registry && <WritingSceneMargin scene={scene} registry={registry} wordCount={metadata?.wordCount ?? 0}
          number={(chapter?.scenes.findIndex(value => value.id === scene.sceneId) ?? index) + 1} title={metadata?.title ?? ''} stage={stages.find(stage => stage.key === metadata?.stage)}
          onFocus={scope === 'scene' ? undefined : onFocusScene}
          synopsisVisible={showSynopsis} narrow={narrow} expanded={expanded.has(scene.sceneId)} onExpandedChange={toggleExpanded} />}
      </>, element, scene.sceneId)
    })}
    {emptyTargets.map(({ chapter, element }) => createPortal(<>
      <button type="button" className="writing-boundary-insert" data-writing-insert="chapter" onClick={() => insertBefore(chapter.guid, chapter.act || null)}>+ {t('shell.newChapter')}</button>
      {!chapter.hideHeading && <header className="writing-chapter-heading">
        {registry && chapter.act && <div className="writing-act-name"><WritingMetadataName structural value={chapter.act} label={t('structure.renameAct')}
          context={registry.context} save={newName => executeWritingStructure({ kind: 'renameAct', oldName: chapter.act, newName })} /></div>}
        <h2>{registry ? <WritingMetadataName value={chapter.title} label={t('dialog.chapterName')} context={registry.context}
          save={title => useProjectStore.getState().renameChapter(chapter.guid, title)} /> : chapter.title}</h2>
        {chapter.subtitle && <p dir="auto">{chapter.subtitle}</p>}</header>}
      <button type="button" className="writing-boundary-insert" data-writing-insert="scene" onClick={() => onStructure({ command: 'insertScene', selection: null, anchor: null,
        sceneDestination: { chapterGuid: chapter.guid, beforeSceneId: null } })}>+ {t('shell.newScene')}</button>
    </>, element, chapter.guid))}
    {endTarget && boundaries.end && createPortal(<WritingBoundaryActions requests={boundaries.end} onStructure={onStructure} />, endTarget)}
  </>
})
