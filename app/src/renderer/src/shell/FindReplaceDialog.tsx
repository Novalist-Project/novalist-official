import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import '../../public/editor/shortcut-key.js'
import { useProjectStore } from '../stores/projectStore'
import { capturePendingWrites } from '../stores/pendingWrites'
import { useDialogAutoFocus, useDialogKeyboard } from './useDialogKeyboard'
import { ConfirmDialog } from './ConfirmDialog'
import { isNote, navigateToMatch, searchManuscript, type FindMatchDto, type FindResults, type ReplaceAction, type ReplacementResult } from './findReplaceSearch'
import { hasPendingWritingReplacement, retryWritingReplacement } from '../views/editor/writingSearchExternal'
import type { WritingFindOptions } from '../views/editor/writingSearch'

const SCOPES = ['Projection', 'CurrentScene', 'CurrentChapter', 'ActiveBook', 'Project']
const CHECKBOXES = { matchCase: 'matchCase', wholeWord: 'wholeWord', regex: 'useRegex', includeNotes: 'includeSceneNotes', includeCodex: 'includeCodex' } as const
const INITIAL_OPTIONS: WritingFindOptions = { pattern: '', matchCase: false, wholeWord: false, useRegex: false, includeSceneNotes: false, includeCodex: false }

function useFindReplace(onClose: () => void) {
  const { t } = useTranslation()
  const mobile = window.novalist.isMobile
  const [options, setOptions] = useState(INITIAL_OPTIONS)
  const [replacement, setReplacement] = useState('')
  const [scope, setScope] = useState(mobile ? 'ActiveBook' : 'Projection')
  const [results, setResults] = useState<FindResults | null>(null)
  const [current, setCurrent] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<ReplacementResult | 'undone' | null>(null)
  const requestId = useRef(0)
  const running = useRef(false)
  const workspaceEpoch = useProjectStore(state => state.workspaceEpoch)
  const projectPath = useProjectStore(state => state.projectPath)
  const mobileChapter = useProjectStore(state => mobile && scope.startsWith('Current') && state.openChapterGuid)
  const mobileScene = useProjectStore(state => mobile && scope === 'CurrentScene' && state.openSceneId)

  useEffect(() => {
    requestId.current++
    setResults(null)
    setCurrent(0)
    setError('')
    setOutcome(null)
  }, [options, scope, workspaceEpoch, projectPath, mobileChapter, mobileScene])

  async function run<T>(work: () => Promise<T>, accept: (value: T) => void) {
    if (running.current) return
    running.current = true
    const id = ++requestId.current
    setBusy(true)
    setError('')
    try {
      const value = await work()
      if (id === requestId.current) accept(value)
    } catch (reason) {
      if (id === requestId.current) setError(t('findReplace.failed', { message: String(reason) }))
    } finally { running.current = false; setBusy(false) }
  }

  function find() {
    if (!options.pattern || busy || hasPendingWritingReplacement()) return
    setResults(null)
    setCurrent(0)
    setOutcome(null)
    void run(() => searchManuscript(options, scope), setResults)
  }

  function apply(work: () => Promise<ReplacementResult>) {
    void run(work, value => {
      setResults(null)
      setOutcome(value)
      if (value.refreshError) setError(value.refreshError)
    })
  }

  function undo() {
    const revert = outcome && outcome !== 'undone' && outcome.undo
    if (!revert) return
    void run(async () => { capturePendingWrites(); return revert() }, result => {
      if (result.status === 'applied') { setResults(null); setOutcome('undone') }
      else setError(t(result.reason ?? 'writing.historyBlocked'))
    })
  }

  function openMatch(index: number) {
    const match = results?.matches[index]
    if (match) void run(async () => { await navigateToMatch(match); if (mobile) onClose() }, () => setCurrent(index))
  }

  return { options, setOptions, replacement, setReplacement, scope, setScope, results, current, busy, error, outcome, find, apply, undo, openMatch }
}

type FindState = ReturnType<typeof useFindReplace>

function SearchFields({ state }: { state: FindState }) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  useDialogAutoFocus(input)
  const { options, setOptions, scope, setScope } = state
  const disabled = state.busy || hasPendingWritingReplacement()
  return <>
    <input className="dialog-input" ref={input} disabled={disabled} placeholder={t('findReplace.find')} aria-label={t('findReplace.find')}
      value={options.pattern} onChange={event => setOptions({ ...options, pattern: event.target.value })}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) state.find() }} />
    <input className="dialog-input" disabled={disabled} placeholder={t('findReplace.replace')} aria-label={t('findReplace.replace')}
      value={state.replacement} onChange={event => state.setReplacement(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) state.find() }} />
    <div className="findreplace-options">
      {Object.entries(CHECKBOXES).map(([label, key]) => <label className="relationships-toggle" key={key}>
        <input type="checkbox" disabled={disabled} checked={options[key]} onChange={event => setOptions({ ...options, [key]: event.target.checked })} />
        {t(`findReplace.${label}`)}
      </label>)}
      <select className="dialog-input findreplace-scope" disabled={disabled} value={scope} onChange={event => setScope(event.target.value)}>
        {SCOPES.filter(item => item !== 'Projection' || !window.novalist.isMobile).map(item =>
          <option key={item} value={item}>{t(`findReplace.scope${item}`)}</option>)}
      </select>
    </div>
  </>
}

function MatchList({ matches, state }: { matches: FindMatchDto[], state: FindState }) {
  const { t } = useTranslation()
  return <div className="findreplace-results">
    {matches.length === 0 && <p className="codex-empty">{t('findReplace.noMatches')}</p>}
    {matches.map((match, index) => (
      <button key={`${match.sceneId}-${match.field}-${index}`} className="findreplace-result" aria-current={index === state.current || undefined}
        disabled={!match.chapterGuid || state.busy} onClick={() => state.openMatch(index)}>
        <span className="codex-row-detail">
          {match.bookTitle ? `${match.bookTitle} / ` : ''}{match.chapterTitle} - {match.sceneTitle}
          {match.field !== 'prose' && <span className="findreplace-field">{t(`findReplace.field_${match.field}`)}</span>}
        </span>
        <span className="findreplace-snippet">{match.before}<mark>{match.matchedText}</mark>{match.after}</span>
      </button>
    ))}
  </div>
}

function ReplacementStatus({ state }: { state: FindState }) {
  const { t } = useTranslation()
  const { outcome } = state
  const undoButton = useRef<HTMLButtonElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (outcome) (undoButton.current ?? status.current)?.focus() }, [outcome])
  if (!outcome) return null
  return <>
    <p className="inspector-meta" role="status" ref={status} tabIndex={-1}>{outcome === 'undone' ? t('findReplace.undone') : <>
      {t('findReplace.replacedCount', { count: outcome.count })}
      {outcome.count > 0 && outcome.snapshots && ' ' + t('findReplace.snapshotRecovery')}
    </>}</p>
    {outcome !== 'undone' && outcome.undo &&
      <button className="dialog-button" ref={undoButton} disabled={state.busy} onClick={state.undo}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && NovalistShortcutKeys.key(event.nativeEvent) === 'z') {
            event.preventDefault()
            event.stopPropagation()
            state.undo()
          }
        }}>{t('findReplace.undoReplacement')}</button>}
  </>
}

interface Confirmation {
  results: FindResults
  action: ReplaceAction
  selected: FindMatchDto[]
  label: string
  replacement: string
}

function ReplacementActions({ state, onConfirm }: { state: FindState, onConfirm: (confirmation: Confirmation) => void }) {
  const { t } = useTranslation()
  const { results, current, replacement, busy } = state
  const mobile = window.novalist.isMobile
  const matches = results?.matches ?? []
  const locked = busy || hasPendingWritingReplacement()
  const canReplaceAll = (match: FindMatchDto) => match.field === 'prose' || (mobile && isNote(match))
  const labels = {
    current: replacement ? 'replaceCurrent' : 'deleteCurrent',
    all: replacement ? 'replaceAll' : 'deleteMatches',
    notes: replacement ? 'replaceNotes' : 'deleteNoteMatches'
  }

  function choose(action: ReplaceAction) {
    if (!results || locked) return
    const selected = action === 'current' ? matches.slice(current, current + 1).filter(match => match.field === 'prose')
      : matches.filter(action === 'notes' ? isNote : canReplaceAll)
    if (!selected.length) return
    if (action === 'current' && replacement) state.apply(() => results.replace(selected, replacement, action))
    else onConfirm({ results, action, selected, label: labels[action], replacement })
  }

  return <div className="dialog-actions">
    {!mobile && <button className="dialog-button" disabled={locked || matches[current]?.field !== 'prose'} onClick={() => choose('current')}>{t(`findReplace.${labels.current}`)}</button>}
    <button className="dialog-button" disabled={locked || !matches.some(canReplaceAll)} onClick={() => choose('all')}>{t(`findReplace.${labels.all}`)}</button>
    {!mobile && state.options.includeSceneNotes && <button className="dialog-button" disabled={locked || !matches.some(isNote)} onClick={() => choose('notes')}>{t(`findReplace.${labels.notes}`)}</button>}
  </div>
}

export function FindReplaceDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const { t } = useTranslation()
  const state = useFindReplace(onClose)
  const { results, current, busy } = state
  const keyboard = useDialogKeyboard(onClose)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const confirming = confirmation && results === confirmation.results ? confirmation : null
  const matches = results?.matches ?? []
  const pending = hasPendingWritingReplacement()
  const locked = busy || pending
  function step(direction: number) {
    state.openMatch((current + direction + matches.length) % matches.length)
  }

  return <>
    <div className="dialog-overlay" inert={!!confirming} onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div {...keyboard} className="dialog-card findreplace-card" role="dialog" aria-modal="true" aria-label={t('findReplace.title')}>
        <div className="dialog-title">{t('findReplace.title')}</div>
        <SearchFields state={state} />
        <div className="dialog-actions">
          <button className="dialog-button primary" disabled={locked || !state.options.pattern} onClick={state.find}>{t('findReplace.find')}</button>
          {!window.novalist.isMobile && <>
            <button className="dialog-button" disabled={locked || !matches.length} onClick={() => step(-1)}>{t('findReplace.previous')}</button>
            <button className="dialog-button" disabled={locked || !matches.length} onClick={() => step(1)}>{t('findReplace.next')}</button>
          </>}
        </div>
        <ReplacementActions state={state} onConfirm={setConfirmation} />
        {state.error && <p role="alert">{state.error}</p>}
        {pending && <button className="dialog-button" disabled={busy} onClick={() => state.apply(retryWritingReplacement)}>{t('findReplace.retryReplacement')}</button>}
        <ReplacementStatus state={state} />
        {results && <MatchList matches={matches} state={state} />}
      </div>
    </div>
    {confirming && <ConfirmDialog title={t(`findReplace.${confirming.label}`)}
      message={t(confirming.replacement ? 'findReplace.confirmReplacement' : 'findReplace.confirmDeletion', {
        count: confirming.selected.length, scenes: new Set(confirming.selected.map(match =>
          JSON.stringify([match.bookId, match.writing?.ref.draftId, match.chapterGuid, match.sceneId]))).size, replacement: confirming.replacement
      })}
      confirmLabel={t(`findReplace.${confirming.label}`)}
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        setConfirmation(null)
        state.apply(() => confirming.results.replace(confirming.selected, confirming.replacement, confirming.action))
      }} />}
  </>
}
