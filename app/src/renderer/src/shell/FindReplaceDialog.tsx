import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rpc } from '../rpc/client'
import { useProjectStore } from '../stores/projectStore'
import { useDialogAutoFocus, useDialogKeyboard } from './useDialogKeyboard'
import { findWriting, replaceWriting, replaceWritingNotes, revealWritingMatch } from '../views/editor/writingSearchHost'
import type { WritingMatch, WritingSearchResult } from '../views/editor/writingSearch'
import { hasPendingWritingReplacement, retryWritingReplacement } from '../views/editor/writingSearchExternal'

interface FindMatchDto {
  writing?: WritingMatch
  bookId: string | null
  bookTitle: string | null
  chapterGuid: string
  chapterTitle: string
  sceneId: string
  sceneTitle: string
  before: string
  matchedText: string
  after: string
  /** prose | synopsis | notes | comment | codex - where the hit was found. */
  field: string
}

const SCOPES = ['Projection', 'CurrentScene', 'CurrentChapter', 'ActiveBook', 'Project']

async function navigateToMatch(match: FindMatchDto): Promise<void> {
  if (match.field === 'prose' && match.writing) return revealWritingMatch(match.writing)
  const state = useProjectStore.getState()
  if (match.bookId && match.bookId !== state.activeBookId) await state.switchBook(match.bookId)
  if (match.bookId && useProjectStore.getState().activeBookId !== match.bookId) return
  await useProjectStore.getState().openScene(match.chapterGuid, match.sceneId)
}

function useFindReplace(onClose: () => void) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  useDialogAutoFocus(inputRef)
  const keyboard = useDialogKeyboard(onClose)
  const workspaceEpoch = useProjectStore((s) => s.workspaceEpoch)
  const projectPath = useProjectStore((s) => s.projectPath)
  const [pattern, setPattern] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [scope, setScope] = useState(window.novalist.isMobile ? 'ActiveBook' : 'Projection')
  const [includeNotes, setIncludeNotes] = useState(false)
  const [includeCodex, setIncludeCodex] = useState(false)
  const [matches, setMatches] = useState<FindMatchDto[] | null>(null)
  const [search, setSearch] = useState<WritingSearchResult | null>(null)
  const [current, setCurrent] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  useEffect(() => { setMatches(null); setSearch(null); setCurrent(0); setError(null); requestId.current++ }, [pattern, matchCase, wholeWord, useRegex, scope, includeNotes, includeCodex, workspaceEpoch, projectPath])
  const [replacedCount, setReplacedCount] = useState<number | null>(null)

  const find = async (): Promise<void> => {
    if (!pattern || busy) return
    const request = ++requestId.current
    setError(null)
    setMatches(null)
    setBusy(true)
    setReplacedCount(null)
    try {
      if (window.novalist.isMobile) {
        const state = useProjectStore.getState()
        const found = await rpc.request<FindMatchDto[]>('search/find', [pattern, matchCase, wholeWord, useRegex, scope,
          state.openChapterGuid, state.openSceneId, includeNotes, includeCodex])
        if (request === requestId.current) setMatches(found)
        return
      }
      const result = await findWriting({ pattern, matchCase, wholeWord, useRegex, includeSceneNotes: includeNotes, includeCodex }, scope)
      if (request === requestId.current) {
        setSearch(result)
        setMatches(result.matches.map(writing => {
          const target = result.targets.find(target => target.ref.sceneId === writing.ref.sceneId && target.ref.bookId === writing.ref.bookId)
          return { ...writing, writing, bookId: writing.ref.bookId, bookTitle: target?.bookTitle ?? '',
            chapterGuid: writing.ref.chapterGuid, chapterTitle: target?.chapterTitle ?? '',
            sceneId: writing.ref.sceneId, sceneTitle: target?.sceneTitle ?? '' }
        }))
      }
    } catch (reason) {
      if (request === requestId.current) setError(t('findReplace.failed', { message: String(reason) }))
    } finally {
      setBusy(false)
    }
  }

  const replace = async (all: boolean, notes = false): Promise<void> => {
    if ((!search && !window.novalist.isMobile && !hasPendingWritingReplacement()) || busy) return
    const request = ++requestId.current
    setError(null)
    setBusy(true)
    try {
      if (window.novalist.isMobile) {
        const state = useProjectStore.getState()
        const count = await rpc.request<number>('search/replaceAll', [pattern, replacement, matchCase, wholeWord, useRegex,
          scope, state.openChapterGuid, state.openSceneId, includeNotes])
        if (request === requestId.current) { setReplacedCount(count); setMatches(null) }
        if (state.openChapterGuid && state.openSceneId) await state.openScene(state.openChapterGuid, state.openSceneId)
        return
      }
      const selected = all ? search?.matches.filter(match => match.field === 'prose') ?? [] : [search?.matches[current]].filter((match): match is WritingMatch => match?.field === 'prose')
      const count = hasPendingWritingReplacement() ? await retryWritingReplacement()
        : notes ? await replaceWritingNotes(search!, replacement) : await replaceWriting(search!, selected, replacement)
      if (request === requestId.current) setReplacedCount(count)
      setMatches(null)
      setSearch(null)
    } catch (reason) {
      if (request === requestId.current) setError(t('findReplace.failed', { message: String(reason) }))
    } finally {
      setBusy(false)
    }
  }

  const { openMatch, step } = useFindMatchNavigation(matches, current, setCurrent, setError, onClose)
  return { t, inputRef, keyboard, pattern, setPattern, replacement, setReplacement, matchCase, setMatchCase, wholeWord, setWholeWord, useRegex, setUseRegex, scope, setScope, includeNotes, setIncludeNotes, includeCodex, setIncludeCodex, matches, busy, error, replacedCount, find, replace, openMatch, step, current }
}

function useFindMatchNavigation(matches: FindMatchDto[] | null, current: number, setCurrent: (index: number) => void,
  setError: (error: string) => void, onClose: () => void) {
  const { t } = useTranslation()
  const openMatch = async (match: FindMatchDto): Promise<void> => {
    try {
      await navigateToMatch(match)
      if (window.novalist.isMobile) onClose()
      setCurrent(matches?.indexOf(match) ?? 0)
    } catch (reason) {
      setError(t('findReplace.failed', { message: String(reason) }))
    }
  }

  const step = (direction: number): void => {
    if (!matches?.length) return
    const index = (current + direction + matches.length) % matches.length
    void openMatch(matches[index])
  }
  return { openMatch, step }
}

export function FindReplaceDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const { t, inputRef, keyboard, pattern, setPattern, replacement, setReplacement, matchCase, setMatchCase, wholeWord, setWholeWord, useRegex, setUseRegex, scope, setScope, includeNotes, setIncludeNotes, includeCodex, setIncludeCodex, matches, busy, error, replacedCount, find, replace, openMatch, step, current } = useFindReplace(onClose)

  return (
    <div className="dialog-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div {...keyboard} className="dialog-card findreplace-card" role="dialog" aria-modal="true" aria-label={t('findReplace.title')}>
        <div className="dialog-title">{t('findReplace.title')}</div>
        <input
          className="dialog-input"
          placeholder={t('findReplace.find')}
          value={pattern}
          disabled={busy || hasPendingWritingReplacement()}
          ref={inputRef}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void find()
          }}
        />
        <input
          className="dialog-input"
          placeholder={t('findReplace.replace')}
          value={replacement}
          disabled={busy || hasPendingWritingReplacement()}
          onChange={(e) => setReplacement(e.target.value)}
        />
        <div className="findreplace-options">
          <label className="relationships-toggle">
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
            {t('findReplace.matchCase')}
          </label>
          <label className="relationships-toggle">
            <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
            {t('findReplace.wholeWord')}
          </label>
          <label className="relationships-toggle">
            <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
            {t('findReplace.regex')}
          </label>
          <label className="relationships-toggle">
            <input
              type="checkbox"
              checked={includeNotes}
              onChange={(e) => setIncludeNotes(e.target.checked)}
            />
            {t('findReplace.includeNotes')}
          </label>
          <label className="relationships-toggle">
            <input
              type="checkbox"
              checked={includeCodex}
              onChange={(e) => setIncludeCodex(e.target.checked)}
            />
            {t('findReplace.includeCodex')}
          </label>
          <select className="dialog-input findreplace-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            {SCOPES.filter(scope => scope !== 'Projection' || !window.novalist.isMobile).map((s) => (
              <option key={s} value={s}>
                {t(`findReplace.scope${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-actions">
          <button className="dialog-button" disabled={busy || hasPendingWritingReplacement()} onClick={() => void find()}>
            {t('findReplace.find')}
          </button>
          {!window.novalist.isMobile && <>
            <button className="dialog-button" disabled={busy || !matches?.length} onClick={() => step(-1)}>{t('findReplace.previous')}</button>
            <button className="dialog-button" disabled={busy || !matches?.length} onClick={() => step(1)}>{t('findReplace.next')}</button>
            <button className="dialog-button" disabled={busy || hasPendingWritingReplacement() || matches?.[current]?.field !== 'prose'} onClick={() => void replace(false)}>{t('findReplace.replaceCurrent')}</button>
          </>}
          <button className="dialog-button primary" disabled={busy || hasPendingWritingReplacement() || (window.novalist.isMobile ? !pattern : !matches?.some(match => match.field === 'prose'))} onClick={() => void replace(true)}>
            {t('findReplace.replaceAll')}
          </button>
          {includeNotes && !window.novalist.isMobile && <button className="dialog-button" disabled={busy || !matches?.some(match => match.field === 'notes' || match.field === 'synopsis')} onClick={() => void replace(true, true)}>
            {t('findReplace.replaceNotes')}
          </button>}
        </div>
        {error && <p role="alert">{error}</p>}
        {hasPendingWritingReplacement() && <button className="dialog-button" disabled={busy} onClick={() => void replace(true)}>{t('findReplace.retryReplacement')}</button>}
        {replacedCount !== null && (
          <p className="inspector-meta">{t('findReplace.replacedCount', { count: replacedCount })}</p>
        )}
        {matches && (
          <div className="findreplace-results">
            {matches.length === 0 && <p className="codex-empty">{t('findReplace.noMatches')}</p>}
            {matches.map((match, index) => (
              <button
                key={`${match.sceneId}-${match.field}-${index}`}
                className="findreplace-result"
                aria-current={index === current ? 'true' : undefined}
                // A Codex hit has no scene behind it, so it reports and stays put.
                disabled={!match.chapterGuid}
                onClick={() => void openMatch(match)}
              >
                <span className="codex-row-detail">
                  {match.bookTitle ? `${match.bookTitle} / ` : ''}{match.chapterTitle} - {match.sceneTitle}
                  {match.field !== 'prose' && (
                    <span className="findreplace-field">{t(`findReplace.field_${match.field}`)}</span>
                  )}
                </span>
                <span className="findreplace-snippet">
                  {match.before}
                  <mark>{match.matchedText}</mark>
                  {match.after}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
