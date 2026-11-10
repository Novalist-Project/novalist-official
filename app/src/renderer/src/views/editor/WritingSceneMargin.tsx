import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import createDOMPurify from 'dompurify'
import { createSceneSanitizer } from '../../../../shared/sceneSanitizer'
import { SceneSynopsisField } from '../../shell/SceneSynopsisField'
import { computeStats } from '../../shell/textStatistics'
import { writingCountText } from './writingPresentation'
import { getSharedWritingSession } from '../../collaboration/sharedWritingSessions'
import type { WritingDocumentRegistry } from '../../stores/writingDocuments'
import type { SceneRef } from './writingTypes'
import type { SceneStage } from '../../stores/stageStore'
import { ChevronDown, Scan } from 'lucide-react'
import { WritingSceneName, WritingSceneStage } from './WritingSceneMetadata'

const { sanitizeSceneFragment } = createSceneSanitizer(window, createDOMPurify(window))

export function WritingSceneMargin({ scene, expanded, onExpandedChange, wordCount, registry, number, title = '', stage, onFocus, narrow = false, synopsisVisible = true }: {
  scene: SceneRef; expanded: boolean; onExpandedChange(expanded: boolean): void; wordCount: number
  registry: WritingDocumentRegistry
  narrow?: boolean
  synopsisVisible?: boolean
  number: number
  title?: string
  stage?: SceneStage
  onFocus?(): void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const subscribe = useCallback((listener: () => void) => registry.subscribe(scene, listener), [registry, scene])
  const snapshot = useSyncExternalStore(subscribe, () => registry.getSnapshot(scene))
  const owner = useMemo(() => snapshot?.shared ? getSharedWritingSession(snapshot.shared) : null, [snapshot?.shared])
  const subscribeShared = useCallback((listener: () => void) => owner?.subscribe(listener) ?? (() => {}), [owner])
  const html = useSyncExternalStore(subscribeShared, () => owner?.html ?? snapshot?.html)
  const anchor = useRef<HTMLButtonElement>(null)
  const count = useMemo(() => {
    if (html === undefined || snapshot?.revision === 0 && html === snapshot.html) return wordCount
    return computeStats(writingCountText(sanitizeSceneFragment(html)), i18n.language).wordCount
  }, [html, wordCount, i18n.language, snapshot?.revision, snapshot?.html])
  return <aside className={`writing-scene-margin${expanded && synopsisVisible ? ' expanded' : ''}`}>
    <span className="writing-scene-number">{t('unifiedWriting.sceneNumber', { number: String(number).padStart(2, '0') })}</span>
    <WritingSceneName scene={scene} title={title} context={registry.context} />
    <WritingSceneStage scene={scene} stage={stage} context={registry.context} />
    <small>{t('unifiedWriting.words', { count })}</small>
    {synopsisVisible && <button ref={anchor} type="button" aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}>
      <ChevronDown size={13} className={expanded ? 'expanded' : ''} />{t('unifiedWriting.synopsis')}
    </button>}
    {synopsisVisible && expanded && (narrow ? <SynopsisPopover scene={scene} anchor={anchor.current} onClose={() => onExpandedChange(false)} /> :
      <SceneSynopsisField chapterGuid={scene.chapterGuid} sceneId={scene.sceneId} className="writing-synopsis-input" multiline />)}
    {onFocus && <button type="button" className="writing-focus-scene" onClick={onFocus}><Scan size={13} />{t('unifiedWriting.focusScene')}</button>}
  </aside>
}

function SynopsisPopover({ scene, anchor, onClose }: { scene: SceneRef; anchor: HTMLElement | null; onClose(): void }): React.JSX.Element {
  const { t } = useTranslation()
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const popover = element.current
    if (!popover || !anchor) return
    const rect = anchor.getBoundingClientRect()
    popover.showPopover()
    const viewport = anchor.ownerDocument.documentElement
    popover.style.left = `${Math.max(0, Math.min(rect.left, viewport.clientWidth - popover.offsetWidth))}px`
    popover.style.top = `${Math.max(0, Math.min(rect.bottom, viewport.clientHeight - popover.offsetHeight))}px`
  }, [anchor])
  return <div ref={element} popover="auto" className="writing-synopsis-popover" onToggle={event => { if (event.newState === 'closed') onClose() }}>
    <strong>{t('sceneNotes.synopsisTitle')}</strong>
    <SceneSynopsisField chapterGuid={scene.chapterGuid} sceneId={scene.sceneId} className="writing-synopsis-input" multiline />
    <button type="button" onClick={onClose}>{t('dialog.close')}</button>
  </div>
}
