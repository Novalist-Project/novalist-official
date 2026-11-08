import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { rpc } from '../../rpc/client'
import { useHostBridgeStore } from '../../stores/hostBridgeStore'
import { editorPane, useProjectStore, type SceneDto } from '../../stores/projectStore'
import { useShellStore } from '../../stores/shellStore'
import { stackMembers, type EditorScope, type StackMember } from '../../stores/stackedPaneIds'
import {
  activateEditorPane,
  insertSceneAfter,
  loadStackedScene,
  releaseStackedScene,
  setStackedSynopsis,
  useStackedEditorStore
} from '../../stores/stackedEditors'
import { setSceneMetadata } from '../../shell/sceneMetadataActions'
import { ScenePlanningText } from '../../collaboration/ScenePlanningText'
import { computeStats } from '../../shell/textStatistics'
import { EditorFrame } from './EditorFrame'
import { EditorToolbar, type FormattingState } from './EditorToolbar'
import { EditorScopeSwitch } from './EditorScopeSwitch'
import './stacked-editor.css'

interface SceneLabel { key: string; label: string; color: string }

const IDLE_FORMATTING: FormattingState = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  highlight: false,
  alignment: 'left',
  paragraphStyle: '',
  bulletList: false,
  numberList: false,
  hasSelection: false,
  linkActive: false,
  entityAtCaret: false
}

function reportFailure(error: unknown): void {
  useHostBridgeStore.getState().pushToast(error instanceof Error ? error.message : String(error))
}

/** Height kept for a scene whose editor is not mounted, until it is measured. */
const UNMEASURED_HEIGHT = 480

/** Last measured height per scene, so a scene scrolled away and back holds its place. */
const measuredHeights = new Map<string, number>()

/**
 * The chapter or the whole manuscript, one full scene editor per scene, with
 * each scene's title, synopsis and label beside its prose.
 *
 * Every scene is its own editor rather than one long document, so comments,
 * footnotes, grammar, mentions, suggestions and conflict handling behave as
 * they do with one scene open. Editors far from the screen are let go (after
 * their words are written) and come back as they scroll near again, so a long
 * book does not hold hundreds of editors at once.
 */
export function StackedEditor({ paneId, scope }: { paneId: string; scope: Exclude<EditorScope, 'scene'> }): React.JSX.Element {
  const { t } = useTranslation()
  const host = useProjectStore((s) => editorPane(s, paneId))
  const chapters = useProjectStore((s) => s.chapters)
  const activeEditorPaneId = useProjectStore((s) => s.activeEditorPaneId)
  const writingHere = useShellStore((s) => s.mainView === 'write' && !s.extView)
  const formatting = useStackedEditorStore((s) => s.formatting)
  const speaking = useStackedEditorStore((s) => s.speaking)
  const scrollRequest = useStackedEditorStore((s) => s.scrollRequest)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [labels, setLabels] = useState<SceneLabel[]>([])
  const members = useMemo(
    () => stackMembers(chapters, scope, paneId, host),
    [chapters, scope, paneId, host]
  )
  const scenesById = useMemo(
    () => new Map(chapters.flatMap((chapter) => chapter.scenes.map((scene) => [scene.id, scene] as const))),
    [chapters]
  )
  const activeMember = members.find((member) => member.paneId === activeEditorPaneId)
    ?? members.find((member) => member.paneId === paneId)
  const isActiveStack = writingHere && members.some((member) => member.paneId === activeEditorPaneId)

  useEffect(() => {
    void rpc.request<SceneLabel[]>('labels/list').then(setLabels).catch(() => setLabels([]))
  }, [chapters])

  // Arriving at the stack lands on the scene that was opened, not the top.
  // Opening a scene from another chapter swaps the whole stack without
  // remounting it, so this follows the opened scene rather than running once.
  useEffect(() => {
    if (host.sceneId) scrollToScene(scrollRef.current, host.sceneId, 'auto')
  }, [host.sceneId])

  useEffect(() => {
    if (scrollRequest) scrollToScene(scrollRef.current, scrollRequest.sceneId, 'smooth')
  }, [scrollRequest])

  const activeScene = activeMember ? scenesById.get(activeMember.sceneId) : undefined
  return (
    <div className="editor-pane stacked-editor" data-scope={scope}>
      {!window.novalist.isMobile && (
        <div className="editor-scene-heading">
          <div>
            <strong>{activeScene?.title ?? ''}</strong>
            <small>{activeMember?.chapterTitle ?? ''}</small>
          </div>
          <EditorScopeSwitch />
          <button className="dialog-button" onClick={() => useShellStore.getState().toggleFocusMode()}>
            {t('menu.focusMode')}
          </button>
          <button className="dialog-button" onClick={() => useShellStore.getState().toggleInspector()}>
            {t('desktopRefresh.sceneDetails')}
          </button>
        </div>
      )}
      <EditorToolbar formatting={formatting ?? IDLE_FORMATTING} speaking={speaking} active={isActiveStack} />
      <div className="stacked-editor-scroll" ref={scrollRef}>
        {members.map((member, index) => {
          const scene = scenesById.get(member.sceneId)
          if (!scene) return null
          return (
            <div key={member.sceneId}>
              {scope === 'manuscript' && member.opensChapter && (
                <h2 className="stacked-editor-chapter">{member.chapterTitle}</h2>
              )}
              <StackedScene
                scrollRoot={scrollRef}
                member={member}
                scene={scene}
                labels={labels}
                hostPaneId={paneId}
                eager={member.paneId === paneId}
                active={member.paneId === activeEditorPaneId}
              />
              <SceneDivider
                onNewScene={() => void insertSceneAfter(
                  member.chapterGuid,
                  member.sceneId,
                  t('stackedEditor.newSceneTitle', { number: chapterSceneNumber(members, index) + 1 })
                )}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function chapterSceneNumber(members: StackMember[], index: number): number {
  const chapterGuid = members[index].chapterGuid
  return members.slice(0, index + 1).filter((member) => member.chapterGuid === chapterGuid).length
}

function scrollToScene(container: HTMLElement | null, sceneId: string, behavior: ScrollBehavior): void {
  const target = container?.querySelector<HTMLElement>(`[data-stacked-scene="${CSS.escape(sceneId)}"]`)
  target?.scrollIntoView({ behavior, block: 'start' })
}

/**
 * One scene's row: its editor, mounted while it is near the screen, and the
 * column describing it.
 */
function StackedScene({ scrollRoot, member, scene, labels, hostPaneId, eager, active }: {
  scrollRoot: React.RefObject<HTMLDivElement | null>
  member: StackMember
  scene: SceneDto
  labels: SceneLabel[]
  hostPaneId: string
  eager: boolean
  active: boolean
}): React.JSX.Element {
  const rowRef = useRef<HTMLElement>(null)
  const near = useNearViewport(rowRef, scrollRoot, eager || active)

  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (near && row.offsetHeight > 0) measuredHeights.set(member.sceneId, row.offsetHeight)
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [member.sceneId, near])

  return (
    <section
      ref={rowRef}
      className={`stacked-editor-scene${active ? ' active' : ''}`}
      data-stacked-scene={member.sceneId}
      style={near ? undefined : { minHeight: measuredHeights.get(member.sceneId) ?? UNMEASURED_HEIGHT }}
    >
      <div className="stacked-editor-prose">
        {near && <StackedSceneEditor member={member} isHost={member.paneId === hostPaneId} />}
      </div>
      <SceneColumn member={member} scene={scene} labels={labels} />
    </section>
  )
}

/** Holds a stacked scene's editor entry for as long as the row shows it. */
function StackedSceneEditor({ member, isHost }: { member: StackMember; isHost: boolean }): React.JSX.Element | null {
  const loaded = useProjectStore((s) => s.editors[member.paneId]?.sceneId === member.sceneId)
  useEffect(() => {
    if (isHost) return
    void loadStackedScene(member.paneId, member.chapterGuid, member.sceneId).catch(reportFailure)
    return () => void releaseStackedScene(member.paneId)
  }, [isHost, member.paneId, member.chapterGuid, member.sceneId])
  return loaded ? <EditorFrame paneId={member.paneId} stacked /> : null
}

/**
 * True while the element is within a few screens of the stack's visible area.
 * Unlike the corkboard's lazy blocks this lets go again, because an editor
 * costs far more than a card. Measured against the stack's own scroll box: a
 * row clipped by it never intersects the window, however wide the margin.
 */
function useNearViewport(
  ref: React.RefObject<HTMLElement | null>,
  root: React.RefObject<HTMLElement | null>,
  pinned: boolean
): boolean {
  const [near, setNear] = useState(pinned)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: root.current, rootMargin: '200% 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, root])
  return near || pinned
}

/** Title, word count, synopsis and label, beside the prose they describe. */
function SceneColumn({ member, scene, labels }: { member: StackMember; scene: SceneDto; labels: SceneLabel[] }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const liveText = useProjectStore((s) => s.editors[member.paneId]?.sceneId === member.sceneId
    ? s.editors[member.paneId].plainText
    : null)
  const words = liveText === null ? scene.wordCount : computeStats(liveText, i18n.language).wordCount
  const [synopsis, setSynopsis] = useState(scene.synopsis ?? '')
  useEffect(() => setSynopsis(scene.synopsis ?? ''), [scene.synopsis])
  const labelKey = scene.labelKey?.toLowerCase()
  const label = labelKey ? labels.find((entry) => entry.key.toLowerCase() === labelKey) : undefined
  const target = [{ chapterGuid: member.chapterGuid, sceneId: member.sceneId }]
  const setLabel = (key: string | null): void => {
    void setSceneMetadata(target, 'label', key, (entry) => rpc.request('labels/setScene', [entry.sceneId, key]))
  }

  return (
    <aside className="stacked-editor-column" aria-label={scene.title}>
      <button
        type="button"
        className="stacked-editor-title"
        onClick={() => {
          useStackedEditorStore.getState().revealScene(member.sceneId)
          activateEditorPane(member.paneId)
        }}
      >
        <span>{t('stackedEditor.sceneHeading', { chapter: member.chapterTitle, scene: scene.title })}</span>
        <span className="stacked-editor-words">{t('stackedEditor.words', { count: words })}</span>
      </button>
      <ScenePlanningText
        sceneId={member.sceneId}
        field="synopsis"
        label={t('sceneNotes.synopsisTitle')}
        value={synopsis}
        rows={2}
      >
        <textarea
          className="stacked-editor-synopsis"
          aria-label={t('sceneNotes.synopsisTitle')}
          placeholder={t('stackedEditor.synopsisPlaceholder')}
          value={synopsis}
          rows={2}
          onChange={(event) => setSynopsis(event.target.value)}
          onBlur={() => {
            if (synopsis !== (scene.synopsis ?? '')) {
              // The typed text stays in the box, so the next blur retries.
              void setStackedSynopsis(member.chapterGuid, member.sceneId, synopsis).catch(reportFailure)
            }
          }}
        />
      </ScenePlanningText>
      <div className="stacked-editor-labels">
        {label && (
          <span className="stacked-editor-label" style={{ borderColor: label.color }}>
            <span className="stacked-editor-label-dot" style={{ background: label.color }} aria-hidden="true" />
            {label.label}
            <button
              type="button"
              className="stacked-editor-label-remove"
              aria-label={t('stackedEditor.removeLabel', { label: label.label })}
              onClick={() => setLabel(null)}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </span>
        )}
        {labels.length > 0 && (
          <select
            className="stacked-editor-label-picker"
            aria-label={t('labels.set')}
            value=""
            onChange={(event) => setLabel(event.target.value || null)}
          >
            <option value="">{t('labels.set')}</option>
            {labels.map((entry) => (
              <option key={entry.key} value={entry.key}>{entry.label}</option>
            ))}
          </select>
        )}
      </div>
    </aside>
  )
}

/** The ornament between two scenes, and the way to start a new one there. */
function SceneDivider({ onNewScene }: { onNewScene(): void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="stacked-editor-divider">
      <div className="stacked-editor-ornament" aria-hidden="true">
        <svg viewBox="0 0 180 24" width="180" height="24" fill="none" stroke="currentColor" strokeWidth="1.25">
          <path d="M4 12h58M68 12h5M107 12h5M118 12h58" />
          <path d="M4 12l5-3M4 12l5 3M176 12l-5-3M176 12l-5 3" />
          <circle cx="65" cy="12" r="2.25" fill="currentColor" stroke="none" />
          <circle cx="115" cy="12" r="2.25" fill="currentColor" stroke="none" />
          <path d="M73 12l9-9 9 9-9 9z" />
          <path d="M89 12l9-9 9 9-9 9z" />
        </svg>
      </div>
      <button type="button" className="stacked-editor-new" onClick={onNewScene}>
        <Plus size={14} strokeWidth={2} />
        {t('stackedEditor.newScene')}
      </button>
    </div>
  )
}
