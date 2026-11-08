import { useEditorMessages } from './useEditorMessages'
import { type CSSProperties, useEffect, useState } from 'react'
import { editorWindow, listenToEditor } from './editorBridge'
import { useStackedEditorStore } from '../../stores/stackedEditors'
import { EditorScopeSwitch } from './EditorScopeSwitch'
import { EditorToolbar } from './EditorToolbar'
import { useShellStore } from '../../stores/shellStore'
import { EntityTypeDialog } from '../../shell/EntityTypeDialog'
import { AppendToEntityDialog } from '../../shell/AppendToEntityDialog'
import { InputDialog } from '../../shell/InputDialog'
import { MotionPresence } from '../../shell/MotionPresence'
import './editor.css'
import { useEditorFrameModel, type EditorFrameModel } from './useEditorFrameModel'
import { useEditorPersistence, useEditorScene, useEditorControls } from './useEditorSynchronization'
import { useTranslation } from 'react-i18next'
import { editorPane, useProjectStore, type SceneTabRef } from '../../stores/projectStore'
import { useContentTransition } from '../../shell/useContentTransition'

/**
 * One scene's editor.
 *
 * `stacked` is a scene inside the chapter or manuscript stack: the stack draws
 * the heading and the toolbar once above every scene, so this frame draws only
 * the prose, as tall as the prose is.
 */
export function EditorFrame({ paneId, stacked = false }: { paneId?: string; stacked?: boolean }): React.JSX.Element {
  const model = useEditorFrameModel({ paneId })
  const stackedHeight = useStackedFrame(model, stacked)
  const suspendMotion = useProjectStore((s) => s.closingProject || s.workspaceSuspended)
  const { editorFontSize, peekScope, t, pane, formatting, speaking, isActiveEditor, showFocusPeekTip, editorRef, completeFocusPeekTip, dismissFocusPeekTip, iframeRef, peek, pendingEntity, createPendingEntity, cancelPendingEntity, pendingAppend, appendSelectionToEntity, setPendingAppend, linkPrompt, setLinkPrompt, pendingImage, setPendingImage, lastReportedHtmlRef, loadingRef, loadAnnotations, applyFootnoteOrder, pushEntityNames, peekRef, i18n, sceneTitleRef, annotationsRef, persistAnnotations, pushAnnotations, paneIds, setPendingEntity, entityIndexRef, setSpeaking, setFormatting } = model
  useEditorPersistence(model)
  useEditorScene(model)
  useContentTransition(model.iframeRef, model.openSceneId ?? '')
  useEditorMessages({
    iframeRef, pane, peekRef, editorRef, i18n, loadingRef, lastReportedHtmlRef, loadAnnotations, applyFootnoteOrder, pushEntityNames, t, setPendingImage, sceneTitleRef, setLinkPrompt, annotationsRef, persistAnnotations, pushAnnotations, paneIds, setPendingAppend, setPendingEntity, entityIndexRef, setSpeaking, setFormatting
  })
  useEditorControls(model)
  return (
    <div
      className={stacked ? 'editor-pane editor-pane-stacked' : 'editor-pane'}
      style={{ '--nl-focus-page-scale': editorFontSize / 17 } as CSSProperties}
    >
      {!stacked && !window.novalist.isMobile && (
        <div className="editor-scene-heading">
          <div>
            <strong>{peekScope.sceneTitle}</strong>
            <small>{peekScope.chapterTitle}</small>
          </div>
          <EditorScopeSwitch />
          <button
            className="dialog-button"
            onClick={() => useShellStore.getState().toggleFocusMode()}
          >
            {t('menu.focusMode')}
          </button>
          <button
            className="dialog-button"
            onClick={() => useShellStore.getState().toggleInspector()}
          >
            {t('desktopRefresh.sceneDetails')}
          </button>
        </div>
      )}
      {!stacked && <SceneTabStrip paneId={pane} />}
      {!stacked && <EditorToolbar formatting={formatting} speaking={speaking} active={isActiveEditor} />}
      {!stacked && isActiveEditor && formatting.entityAtCaret && showFocusPeekTip && (
        <section
          className="editor-onboarding-tip"
          aria-label={t('focusPeek.tipTitle')}
          data-onboarding-tip="focus-peek"
        >
          <div className="editor-onboarding-copy">
            <strong>{t('focusPeek.tipTitle')}</strong>
            <span>{t('focusPeek.tipBody')}</span>
          </div>
          <div className="editor-onboarding-actions">
            <button
              className="btn-primary"
              onClick={() => {
                if (editorRef.current?.peekEntityAtCaret()) completeFocusPeekTip('focus-peek')
              }}
            >
              {t('focusPeek.tipTry')}
            </button>
            <button className="btn-secondary" onClick={() => dismissFocusPeekTip('focus-peek')}>
              {t('focusPeek.tipDismiss')}
            </button>
          </div>
        </section>
      )}
      <iframe
        ref={iframeRef}
        className={stacked ? 'editor-frame editor-frame-stacked' : 'editor-frame'}
        style={stacked && stackedHeight > 0 ? { height: stackedHeight } : undefined}
        src="./editor/editor.html"
        title="editor"
        sandbox="allow-scripts allow-same-origin"
      />
      {peek.overlay}
      <MotionPresence disabled={suspendMotion}>{pendingEntity && (
        <EntityTypeDialog
          name={pendingEntity.name}
          onPick={(typeKey) => void createPendingEntity(typeKey)}
          onCancel={cancelPendingEntity}
        />
      )}</MotionPresence>
      <MotionPresence disabled={suspendMotion}>{pendingAppend != null && (
        <AppendToEntityDialog
          text={pendingAppend}
          onConfirm={(target) => void appendSelectionToEntity(target)}
          onCancel={() => setPendingAppend(null)}
        />
      )}</MotionPresence>
      {/* The frame owns no dialogs, so it asks and the host answers. An empty
          address unlinks, which is how a link is taken off again. */}
      <MotionPresence disabled={suspendMotion}>{linkPrompt && (
        <InputDialog
          title={t('editor.linkPrompt')}
          placeholder="https://"
          onCancel={() => setLinkPrompt(false)}
          onSubmit={(value) => {
            setLinkPrompt(false)
            editorRef.current?.applyLink(value.trim())
          }}
        />
      )}</MotionPresence>

      {/* Alt text, asked for at insert time. Asking later means never, and a
          picture nobody described is invisible to a reader who cannot see it. */}
      <MotionPresence disabled={suspendMotion}>{pendingImage && (
        <InputDialog
          title={t('editorImage.altTitle')}
          placeholder={t('editorImage.altPlaceholder')}
          onCancel={() => {
            // Cancelling still places the image; a writer who does not want to
            // describe it should not lose the insert over it.
            const path = pendingImage
            setPendingImage(null)
            editorRef.current?.insertImageAtCaret(path, '')
          }}
          onSubmit={(value) => {
            const path = pendingImage
            setPendingImage(null)
            editorRef.current?.insertImageAtCaret(path, value.trim())
          }}
        />
      )}</MotionPresence>
    </div>
  )
}

/**
 * Puts a stacked frame into its sized-to-content layout and follows the height
 * it reports. While it holds the caret, its formatting is published for the
 * one toolbar above the stack.
 */
function useStackedFrame(model: EditorFrameModel, stacked: boolean): number {
  const { iframeRef, isActiveEditor, formatting, speaking } = model
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !stacked) return
    const enter = (): void => {
      const frame = editorWindow(iframe)
      if (frame && typeof frame.setStacked === 'function') frame.setStacked(true)
    }
    // The frame may already be up when this effect re-runs.
    enter()
    return listenToEditor(iframe, (message) => {
      if (message.type === 'ready') enter()
      else if (message.type === 'contentHeight') setHeight(Number(message.height) || 0)
      else if (message.type === 'stackBoundary') moveToNeighbour(iframe, message.direction === 'next' ? 'next' : 'previous')
    })
  }, [iframeRef, stacked])
  useEffect(() => {
    if (stacked && isActiveEditor) useStackedEditorStore.getState().publish(formatting, speaking)
  }, [stacked, isActiveEditor, formatting, speaking])
  return height
}

/**
 * Hands the caret from one stacked scene to the one above or below it. The
 * neighbour is always mounted, because rows near the screen keep their editor.
 */
function moveToNeighbour(iframe: HTMLIFrameElement, direction: 'next' | 'previous'): void {
  const row = iframe.closest('.stacked-editor-scene')
  const scroll = row?.closest('.stacked-editor-scroll')
  if (!row || !scroll) return
  const rows = Array.from(scroll.querySelectorAll('.stacked-editor-scene'))
  const target = rows[rows.indexOf(row) + (direction === 'next' ? 1 : -1)]
  const frame = target?.querySelector<HTMLIFrameElement>('iframe.editor-frame-stacked')
  const neighbour = frame && editorWindow(frame)
  if (!frame || !neighbour || typeof neighbour.focusStackedEdge !== 'function') return
  frame.focus()
  neighbour.focusStackedEdge(direction === 'next' ? 'start' : 'end')
  frame.scrollIntoView({ block: 'nearest' })
}

/** Ordered tab strip for the scenes open in one editor pane. */
export function SceneTabStrip({ paneId }: { paneId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const suspendMotion = useProjectStore((s) => s.closingProject || s.workspaceSuspended)
  const tabs = useProjectStore((s) => editorPane(s, paneId).tabs)
  const activeId = useProjectStore((s) => editorPane(s, paneId).sceneId)
  const chapters = useProjectStore((s) => s.chapters)
  const dirtyMap = useProjectStore((s) => s.dirtyMap)
  const editorCount = useProjectStore(
    (s) => Object.values(s.editors).filter((e) => e.sceneId !== null).length
  )
  const [menu, setMenu] = useState<{ x: number; y: number; sceneId: string } | null>(null)

  // With a second editor open every pane shows its strip, so each side's scene
  // is closeable and the panes look alike. A lone editor keeps the strip-free
  // look until a second scene is opened in it.
  if (tabs.length === 0) return null
  if (editorCount < 2 && tabs.length <= 1) return null

  const titleFor = (ref: SceneTabRef): string => {
    const chapter = chapters.find((c) => c.guid === ref.chapterGuid)
    const scene = chapter?.scenes.find((s) => s.id === ref.sceneId)
    return scene?.title || chapter?.title || ''
  }

  const activate = (ref: SceneTabRef): void => {
    if (ref.sceneId === activeId) return
    void useProjectStore.getState().openSceneIn(paneId, ref.chapterGuid, ref.sceneId)
  }
  const close = (sceneId: string): void => {
    void useProjectStore.getState().closeTab(paneId, sceneId)
  }
  const moveOther = (sceneId: string): void => {
    setMenu(null)
    void useProjectStore.getState().moveTabToOtherPane(paneId, sceneId)
  }

  return (
    <div className="editor-tabs" role="tablist">
      {tabs.map((ref) => (
        <div
          key={ref.sceneId}
          className={`editor-tab${ref.sceneId === activeId ? ' active' : ''}`}
          role="tab"
          aria-selected={ref.sceneId === activeId}
          title={titleFor(ref)}
          onClick={() => activate(ref)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              close(ref.sceneId)
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, sceneId: ref.sceneId })
          }}
        >
          {dirtyMap[ref.sceneId] && <span className="editor-tab-dirty" aria-hidden="true" />}
          <span className="editor-tab-title">{titleFor(ref)}</span>
          <button
            className="editor-tab-close"
            aria-label={t('editor.tabClose')}
            onClick={(e) => {
              e.stopPropagation()
              close(ref.sceneId)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <MotionPresence disabled={suspendMotion}>{menu && (
        <>
          <div
            className="editor-tab-menu-scrim"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div className="editor-tab-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              onClick={() => {
                close(menu.sceneId)
                setMenu(null)
              }}
            >
              {t('editor.tabClose')}
            </button>
            <button onClick={() => moveOther(menu.sceneId)}>{t('editor.tabMoveOther')}</button>
          </div>
        </>
      )}</MotionPresence>
    </div>
  )
}
