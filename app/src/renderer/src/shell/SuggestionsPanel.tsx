import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { useEditorBridge } from '../stores/editorBridgeStore'
import { useSceneSuggestions } from './useSceneSuggestions'

/**
 * Suggested edits waiting on the open scene, one row each.
 *
 * The marks are visible in the prose, but answering them there means hunting
 * through a scene for underlines. A list is how somebody works through twenty
 * of them without missing one.
 */
export function SuggestionsPanel({
  chapterGuid,
  sceneId
}: {
  chapterGuid: string
  sceneId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { suggestions, error, answer: resolve } = useSceneSuggestions(chapterGuid, sceneId)
  const [busy, setBusy] = useState(false)

  /**
   * Takes the writer to the mark this row is about.
   *
   * The marks are drawn in the prose already, but a scene is long and the row
   * says nothing about where in it the edit is - which is how "I can see them
   * in the list and never in the text" happens.
   */
  const showInText = (id: string): void => {
    const bridge = useEditorBridge.getState()
    if (bridge.isShowing(sceneId)) bridge.editor?.scrollToSuggestionById(id)
  }

  const answer = async (accept: boolean, id?: string): Promise<void> => {
    setBusy(true)
    try {
      await resolve(accept, id)
    } finally {
      setBusy(false)
    }
  }

  if (suggestions.length === 0 && !error) return null

  return (
    <div className="suggestions-panel">
      {error && <div role="alert">{t(error)}</div>}
      <div className="inspector-label">
        {t('suggestions.title', { count: suggestions.length })}
      </div>

      {suggestions.map((suggestion) => (
        <div key={suggestion.id} className={`suggestion-row ${suggestion.kind}`}>
          {/* An edit cannot be answered without reading the sentence it is in,
              so the row is also the way to it. */}
          <button
            className="suggestion-body"
            title={t('suggestions.showInText')}
            onClick={() => showInText(suggestion.id)}
          >
            <span className="suggestion-text">{suggestion.text}</span>
            <span className="suggestion-meta">
              {t(`suggestions.${suggestion.kind}`)}
              {suggestion.author ? ` · ${suggestion.author}` : ''}
            </span>
          </button>
          {[
            { label: 'suggestions.accept', accept: true, Icon: Check },
            { label: 'suggestions.reject', accept: false, Icon: X }
          ].map(({ label, accept, Icon }) => (
            <button
              key={label}
              className="ctx-reset"
              disabled={busy}
              title={t(label)}
              aria-label={t(label)}
              onClick={() => void answer(accept, suggestion.id)}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      ))}

      <div className="settings-button-row">
        <button
          className="dialog-button"
          disabled={busy}
          onClick={() => void answer(true)}
        >
          {t('suggestions.acceptAll')}
        </button>
        <button
          className="dialog-button"
          disabled={busy}
          onClick={() => void answer(false)}
        >
          {t('suggestions.rejectAll')}
        </button>
      </div>
    </div>
  )
}
