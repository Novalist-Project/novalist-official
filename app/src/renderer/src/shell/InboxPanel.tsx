import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CornerDownRight, ListTodo, RotateCcw } from 'lucide-react'
import { useProjectStore } from '../stores/projectStore'
import { useShellStore } from '../stores/shellStore'
import { useSuggestionInbox } from './useSuggestionInbox'
import { useCommentInbox } from './useCommentInbox'
import type { InboxItem } from './inboxComments'

const itemKey = (item: InboxItem): string => JSON.stringify([item.chapterGuid, item.sceneId, item.commentId])

/** What can be decided about a note. Order is the order they are offered in. */
const VERDICTS = ['accepted', 'considering', 'declined'] as const

/**
 * Every open note in the book, in one place.
 *
 * A comment could only be found by reopening the scene it was left in - there
 * was no query across them at all - so a note to yourself was lost the moment
 * you closed the scene, and an editor's question had nowhere to be answered.
 */
function useInbox() {
  const { t } = useTranslation()
  const [showResolved, setShowResolved] = useState(false)
  const { items, change, error } = useCommentInbox(showResolved)
  const [todosOnly, setTodosOnly] = useState(false)
  // Suggested edits belong here for the same reason comments do: they are
  // somebody waiting on an answer, and the scene they sit in is the only place
  // they show otherwise.
  const { scenes: suggestionScenes, error: suggestionsError } = useSuggestionInbox()
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')

  const shown = todosOnly ? items.filter((i) => i.isTodo) : items

  return { suggestionScenes, suggestionsError, error, t, todosOnly, setTodosOnly, showResolved, setShowResolved, shown, change, setReplyTo, replyTo, setReplyText, replyText }
}

export function InboxPanel(): React.JSX.Element {
  const { suggestionScenes, suggestionsError, error, t, todosOnly, setTodosOnly, showResolved, setShowResolved, shown, change, setReplyTo, replyTo, setReplyText, replyText } = useInbox()

  return (
    <div className="inbox">
      {suggestionsError && <div role="alert">{t(suggestionsError)}</div>}
      {error && <div role="alert">{t(error)}</div>}
      {suggestionScenes.length > 0 && (
        <div className="inbox-suggestions">
          <div className="inspector-label">{t('inbox.suggestionsTitle')}</div>
          {suggestionScenes.map((scene) => (
            <button
              key={scene.sceneId}
              className="inbox-suggestion-row"
              onClick={() => {
                // Opening the scene was all this did, so following a row that
                // said "2 waiting" landed the writer in a scene with no sign of
                // either of them - and if that scene was already open, nothing
                // happened at all. The edits for the open scene are listed
                // directly above this, and the prose is taken to the first one.
                useShellStore.getState().revealSuggestion(scene.sceneId, '')
                void useProjectStore.getState().openScene(scene.chapterGuid, scene.sceneId)
              }}
            >
              <span className="inbox-suggestion-scene">{scene.sceneTitle}</span>
              <span className="suggestion-meta">
                {scene.chapterTitle} · {t('inbox.suggestionCount', { count: scene.count })}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="inbox-filters">
        <label className="match-toggle">
          <input
            type="checkbox"
            checked={todosOnly}
            onChange={(e) => setTodosOnly(e.target.checked)}
          />
          {t('inbox.todosOnly')}
        </label>
        <label className="match-toggle">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          {t('inbox.showResolved')}
        </label>
      </div>

      {shown.length === 0 && <div className="inbox-empty">{t('inbox.empty')}</div>}

      {shown.map((item) => (
        <div key={itemKey(item)} className={`inbox-item${item.resolved ? ' resolved' : ''}`}>
          <button
            className="inbox-where"
            onClick={() =>
              void useProjectStore.getState().openScene(item.chapterGuid, item.sceneId)
            }
          >
            {item.chapterTitle} - {item.sceneTitle}
          </button>
          {/* What the note was attached to, so it reads as being about
              something rather than floating free of the prose. */}
          {item.anchorText && <div className="inbox-anchor">{item.anchorText}</div>}
          <div className="inbox-text">{item.text}</div>
          {item.author && <div className="inbox-author">{item.author}</div>}
          {/* What was decided, kept visible on the note rather than only in the
              filter - a declined note read six weeks later has to say that it
              was declined, or the second reader saying the same thing reads as
              the first time anybody said it. */}
          {item.verdict && (
            <div className={`inbox-verdict inbox-verdict-${item.verdict}`}>
              {t(`inbox.verdict.${item.verdict}`)}
            </div>
          )}

          {item.replies.map((reply) => (
            <div key={reply.id} className="inbox-reply">
              <CornerDownRight size={11} strokeWidth={2} />
              <span className="inbox-reply-text">{reply.text}</span>
              {reply.author && <span className="inbox-author">{reply.author}</span>}
            </div>
          ))}

          <div className="inbox-actions">
            {VERDICTS.map((verdict) => (
              <button
                key={verdict}
                className={`inbox-action inbox-verdict-btn${item.verdict === verdict ? ' active' : ''}`}
                title={t(`inbox.verdict.${verdict}Hint`)}
                onClick={() => void change(item, { kind: 'verdict', value: item.verdict === verdict ? '' : verdict })}
              >
                {t(`inbox.verdict.${verdict}`)}
              </button>
            ))}
            <button
              className="inbox-action"
              title={t(item.resolved ? 'inbox.reopen' : 'inbox.resolve')}
              onClick={() => void change(item, { kind: 'resolved', value: !item.resolved })}
            >
              {item.resolved ? <RotateCcw size={12} /> : <Check size={12} />}
            </button>
            <button
              className={`inbox-action${item.isTodo ? ' active' : ''}`}
              title={t(item.isTodo ? 'inbox.notATodo' : 'inbox.makeTodo')}
              onClick={() => void change(item, { kind: 'todo', value: !item.isTodo })}
            >
              <ListTodo size={12} />
            </button>
            <button
              className="inbox-action"
              title={t('inbox.reply')}
              onClick={() => {
                setReplyTo(replyTo === itemKey(item) ? null : itemKey(item))
                setReplyText('')
              }}
            >
              <CornerDownRight size={12} />
            </button>
          </div>

          {replyTo === itemKey(item) && (
            <input
              className="inspector-input"
              autoFocus
              placeholder={t('inbox.replyPlaceholder')}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || replyText.trim().length === 0) return
                void change(item, { kind: 'reply', text: replyText }).then(saved => {
                  if (saved) {
                    setReplyTo(null)
                    setReplyText('')
                  }
                })
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}
