import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useEditorBridge } from '../stores/editorBridgeStore'
import { useShellStore } from '../stores/shellStore'
import { useSceneAnnotations } from './useSceneAnnotations'
import { writingErrorMessage } from '../views/editor/writingError'

function AnnotationInput({ value, placeholder, inputRef, onCommit }: {
  value: string
  placeholder?: string
  inputRef?: (input: HTMLInputElement | null) => void
  onCommit(value: string): void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement | null>(null)
  const edited = useRef(false)
  useEffect(() => {
    if (input.current && document.activeElement !== input.current) input.current.value = value
  }, [value])
  return <input className="outliner-input" defaultValue={value} placeholder={placeholder}
    ref={element => { input.current = element; inputRef?.(element) }}
    onFocus={() => { edited.current = false }} onInput={() => { edited.current = true }}
    onBlur={event => {
      if (edited.current && event.currentTarget.value !== value) onCommit(event.currentTarget.value)
      else event.currentTarget.value = value
      edited.current = false
    }} />
}

/** Editable footnotes and comments for the active scene. */
export function AnnotationsPanel({
  chapterGuid,
  sceneId
}: {
  chapterGuid: string
  sceneId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { comments, footnotes, setComments, setFootnotes, persist, remove, error } = useSceneAnnotations(chapterGuid, sceneId)
  const pendingFootnoteText = useShellStore((s) => s.pendingFootnoteText)
  const textBoxes = useRef(new Map<string, HTMLInputElement>())

  /**
   * The caret goes into the note that was just made, so it can be written now
   * rather than found later. The row has to exist first, which is why this
   * waits on the reloaded list rather than running where the request is made.
   */
  useEffect(() => {
    if (!pendingFootnoteText) return
    const box = textBoxes.current.get(pendingFootnoteText)
    if (!box) return
    useShellStore.getState().clearPendingFootnoteText()
    box.focus()
  }, [pendingFootnoteText, footnotes])

  /**
   * The editor, but only while it is showing the scene this panel is about.
   *
   * The panel used to write the shortened list to the backend and tell the
   * prose nothing, so a deleted footnote kept its number in the text and a
   * deleted comment kept its highlight - and the next save wrote the marker
   * straight back out of the editor's own HTML.
   */
  const proseEditor = (): ReturnType<typeof useEditorBridge.getState>['editor'] => {
    const bridge = useEditorBridge.getState()
    return bridge.isShowing(sceneId) ? bridge.editor : null
  }

  /** Takes the writer to the marker, which is the only way to judge a note. */
  const showFootnote = (id: string): void => proseEditor()?.scrollToFootnoteById(id)

  // A blank panel says nothing about whether it is working. The tab is where
  // footnotes live whether or not the scene has any, so it says so.
  if (comments.length === 0 && footnotes.length === 0) {
    return <div className="inspector-placeholder" role={error ? 'alert' : undefined}>
      {error ? writingErrorMessage(error) : t('footnotes.empty')}
    </div>
  }

  return (
    <>
      {error && <div role="alert">{writingErrorMessage(error)}</div>}
      {footnotes.length > 0 && (
        <div className="ctx-section">
          <div className="inspector-label">{t('footnotes.panelTitle')}</div>
          {footnotes.map((fn, index) => (
            <div key={fn.id} className="annotation-row">
              {/* The number is where it sits in the prose, so it is also how
                  to get there. A note you cannot find in the text is one you
                  cannot judge. */}
              <button
                className="annotation-num"
                title={t('footnotes.showInText')}
                aria-label={t('footnotes.showInText')}
                onClick={() => showFootnote(fn.id)}
              >
                {fn.number}
              </button>
              <AnnotationInput
                inputRef={(el) => {
                  if (el) textBoxes.current.set(fn.id, el)
                  else textBoxes.current.delete(fn.id)
                }}
                placeholder={t('footnotes.addPrompt')}
                value={fn.text}
                onCommit={(text) => {
                  const next = footnotes.map((f, i) =>
                    i === index ? { ...f, text } : f
                  )
                  setFootnotes(next)
                  void persist(comments, next)
                }}
              />
              <button
                className="binder-expand"
                aria-label={t('explorer.contextDelete')}
                onClick={() => void remove('footnote', fn.id)}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      {comments.length > 0 && (
        <div className="ctx-section">
          <div className="inspector-label">{t('comments.panelTitle')}</div>
          {comments.map((comment, index) => (
            <div
              key={comment.id}
              className={`annotation-comment${comment.resolved ? ' resolved' : ''}`}
            >
              {comment.anchorText && (
                <span className="annotation-anchor" title={comment.anchorText}>
                  {comment.anchorText}
                </span>
              )}
              <div className="annotation-row">
                <AnnotationInput
                  value={comment.text}
                  onCommit={(text) => {
                    const next = comments.map((c, i) =>
                      i === index ? { ...c, text } : c
                    )
                    setComments(next)
                    void persist(next, footnotes)
                  }}
                />
                <button
                  className="binder-expand"
                  aria-label={t('explorer.contextDelete')}
                  onClick={() => void remove('comment', comment.id)}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
              <label className="annotation-resolve">
                <input
                  type="checkbox"
                  checked={comment.resolved}
                  onChange={(e) => {
                    const next = comments.map((c, i) =>
                      i === index ? { ...c, resolved: e.target.checked } : c
                    )
                    setComments(next)
                    void persist(next, footnotes)
                  }}
                />
                {t('comments.resolved')}
              </label>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
