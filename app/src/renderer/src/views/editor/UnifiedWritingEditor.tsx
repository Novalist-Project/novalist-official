import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorFrame } from './EditorFrame'
import { WritingCanvasChrome } from './WritingCanvasChrome'
import { useUnifiedWritingDocument, type WritingStructureRequest } from './useUnifiedWritingDocument'
import { synopsisVisibilityKey } from './writingPresentation'
import { useFilterStore, isEmptyFilter } from '../../stores/filterStore'
import { useManuscriptStore } from '../../stores/manuscriptStore'
import { useWritingCanvasStyles } from './useWritingCanvas'
import { useWritingInitialZoom } from './useWritingInitialZoom'
import { writingErrorMessage } from './writingError'
import { useProjectStore } from '../../stores/projectStore'
import { PanelRight, FileText, Layers } from 'lucide-react'
import { useShellStore } from '../../stores/shellStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { updateEditorSetting } from '../../shell/commandContext'
import type { SceneRef } from './writingTypes'
import './unified-writing.css'

function requestStructure(request: WritingStructureRequest, paneId: string): void {
  window.dispatchEvent(new CustomEvent('novalist:writing-structure', { detail: { ...request, paneId } }))
}

export function UnifiedWritingEditor({ paneId }: { paneId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const onStructure = useCallback((request: WritingStructureRequest) => requestStructure(request, paneId), [paneId])
  const writing = useUnifiedWritingDocument(paneId, onStructure)
  const focusScene = useCallback((scene: SceneRef) => writing.setScope('scene', scene), [writing.setScope])
  const { live, registry, snapshots, chapters } = writing
  const [showSynopsis, setShowSynopsis] = useState(true)
  const pageView = useSettingsStore(state => state.view?.effective.pageViewEnabled === true)
  const setPageView = useCallback((enabled: boolean) => updateEditorSetting({ pageViewEnabled: enabled }), [])
  const bookTitle = useProjectStore(state => state.books.find(book => book.id === state.activeBookId)?.name ?? '')
  const draftName = useProjectStore(state => state.drafts.find(draft => draft.id === state.activeDraftId)?.name ?? '')
  writing.adapter.pageViewEnabled = pageView
  writing.adapter.changePageView = setPageView
  useEffect(() => { live?.setPageView(pageView) }, [live, pageView])
  const narrow = useWritingCanvasStyles(live)
  useWritingInitialZoom(live, writing.projectionRevision)
  const filter = useFilterStore(state => state.filter)
  const limited = writing.selectedSceneIds !== null || !isEmptyFilter(filter)
  const anchorChapter = writing.scope === 'chapter' ? writing.anchor?.chapterGuid : undefined
  const hasEmptyChapter = useMemo(() => !limited && chapters.some(chapter => chapter.scenes.length === 0 &&
    (writing.scope === 'manuscript' || writing.scope === 'chapter' && chapter.guid === anchorChapter)), [chapters, limited, writing.scope, anchorChapter])

  useEffect(() => {
    if (!registry) return
    setShowSynopsis(localStorage.getItem(synopsisVisibilityKey(registry.context)) !== 'false')
  }, [registry, snapshots])

  const selectedChapter = chapters.find(chapter => chapter.scenes.some(scene => scene.id === writing.selection?.focus.sceneId))
  return <section className="unified-writing-editor" data-writing-pane={paneId}>
    <div className="writing-scope-toolbar">
      <span className="writing-eyebrow">{t('unifiedWriting.write')}</span>
      <div className="writing-scope-segments" role="group" aria-label={t('unifiedWriting.scope')}>
        {(['scene', 'chapter', 'manuscript'] as const).map(scope => <button type="button" key={scope}
          aria-pressed={writing.scope === scope} onClick={() => writing.setScope(scope)}>{t(`unifiedWriting.${scope}`)}</button>)}
      </div>
      <span className="writing-scope-description">{writing.scope === 'scene' ? selectedChapter?.title : t('unifiedWriting.sceneCount', { count: writing.refs.length })}</span>
      <button className="writing-toolbar-icon" type="button" aria-pressed={showSynopsis} title={t('sceneNotes.synopsisTitle')}
        aria-label={t('sceneNotes.synopsisTitle')} onClick={() => {
        const next = !showSynopsis
        if (registry) localStorage.setItem(synopsisVisibilityKey(registry.context), String(next))
        setShowSynopsis(next)
      }}><FileText size={17} /></button>
      <button className="writing-toolbar-icon" type="button" aria-pressed={pageView} title={t('blockStyle.pageView')}
        aria-label={t('blockStyle.pageView')} onClick={() => writing.adapter.changePageView?.(!pageView)}><Layers size={17} /></button>
      <button className="writing-toolbar-icon" type="button" title={t('desktopRefresh.sceneDetails')}
        aria-label={t('desktopRefresh.sceneDetails')} onClick={() => useShellStore.getState().toggleInspector()}><PanelRight size={17} className="icon-directional" /></button>
      {(writing.selectedSceneIds !== null || !isEmptyFilter(filter)) && <>
        <span>{t('unifiedWriting.limitedRun')}</span>
        <button type="button" onClick={() => {
          useManuscriptStore.setState({ composed: null, filterListId: '' })
          useFilterStore.getState().clear()
          writing.setScope('manuscript')
        }}>{t('unifiedWriting.showWhole')}</button>
      </>}
    </div>
    {writing.error && <div role="alert" className="writing-error">{writingErrorMessage(writing.error)}
      <button type="button" onClick={() => void writing.retry()}>{t('shell.retry')}</button>
    </div>}
    {writing.loading && <div role="status">{t('splash.loading')}</div>}
    {!writing.loading && !writing.refs.length && !hasEmptyChapter && <div className="writing-empty">
      <p>{t('unifiedWriting.empty')}</p>
      <button type="button" onClick={() => onStructure({ command: 'insertChapter', selection: null, anchor: null })}>{t('unifiedWriting.insertChapter')}</button>
    </div>}
    <EditorFrame paneId={paneId} writing={writing.adapter} />
    <WritingCanvasChrome live={live} registry={registry} snapshots={snapshots} chapters={chapters} scope={writing.scope}
      anchorChapter={anchorChapter} revision={writing.projectionRevision} limited={limited} narrow={narrow}
      showSynopsis={showSynopsis} onStructure={onStructure} bookTitle={bookTitle} draftName={draftName}
      activeSceneId={writing.selection?.focus.sceneId ?? writing.anchor?.sceneId}
      onFocusScene={focusScene} />
  </section>
}
