import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogKeyboard } from '../shell/useDialogKeyboard'
import { useHostedSessionStore, type MergeChoice, type MergeConflict } from './hostedSessionStore'
import '../shell/scene-conflict.css'
import './mergeConflicts.css'

const conflictKey = (conflict: MergeConflict): string => `${conflict.path}\n${conflict.id}`

/** Readable text for one side: prose without its markup, a field or entry value without JSON quoting. */
export function conflictText(conflict: MergeConflict, value: string | null): string | null {
  if (value === null) return null
  if (conflict.kind === 'prose' || /\.(md|novalist|html?)$/i.test(conflict.path)) {
    const document = new DOMParser().parseFromString(value.replace(/<\/(p|h[1-6]|li|blockquote|pre|div)>|<br\s*\/?>/gi, '$&\n'), 'text/html')
    return (document.body.textContent ?? '').trim()
  }
  if (conflict.kind === 'structure') {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
    } catch { return value }
  }
  return value
}

/**
 * Shown after reconnecting to a persistent server when writing done on this device while it was
 * disconnected collides with another writer's changes. Everything that did not collide is already
 * merged; these places wait, held back, until the writer picks a side for each.
 */
export function MergeConflictDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const conflicts = useHostedSessionStore(state => state.conflicts)
  const open = useHostedSessionStore(state => state.conflictsOpen)
  const [picks, setPicks] = useState<Record<string, MergeChoice>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = (): void => { if (!busy) useHostedSessionStore.getState().showConflicts(false) }
  const keyboard = useDialogKeyboard(close)
  // The writer's own text is the default: they wrote it, and silently preferring another device would surprise them.
  useEffect(() => { setPicks(Object.fromEntries(conflicts.map(conflict => [conflictKey(conflict), 'local' as const]))) }, [conflicts])
  if (!open || conflicts.length === 0) return null
  const takeAll = (side: MergeChoice): void => setPicks(Object.fromEntries(conflicts.map(conflict => [conflictKey(conflict), side])))
  const apply = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await useHostedSessionStore.getState().resolveConflicts(conflicts.map(conflict =>
        ({ path: conflict.path, id: conflict.id, keep: picks[conflictKey(conflict)] ?? 'local' })))
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const side = (conflict: MergeConflict, choice: MergeChoice): React.JSX.Element => {
    const text = conflictText(conflict, choice === 'local' ? conflict.local : conflict.server)
    return <button className={`scene-conflict-cell${picks[conflictKey(conflict)] === choice ? ' chosen' : ''}`} disabled={busy}
      aria-pressed={picks[conflictKey(conflict)] === choice}
      onClick={() => setPicks({ ...picks, [conflictKey(conflict)]: choice })}>
      {text ?? <span className="merge-conflict-missing">{t('collaboration.mergeNoText')}</span>}
    </button>
  }
  return <div className="dialog-overlay">
    <div {...keyboard} className="dialog-card scene-conflict-card" role="dialog" aria-modal="true" aria-label={t('collaboration.mergeTitle')}>
      <div className="dialog-title">{t('collaboration.mergeTitle')}</div>
      <p className="dialog-message">{t('collaboration.mergeExplain', { count: conflicts.length })}</p>
      <div className="scene-conflict-actions">
        <button className="dialog-button" disabled={busy} onClick={() => takeAll('local')}>{t('collaboration.mergeKeepAllMine')}</button>
        <button className="dialog-button" disabled={busy} onClick={() => takeAll('server')}>{t('collaboration.mergeKeepAllServer')}</button>
      </div>
      <div className="scene-conflict-heads">
        <span>{t('collaboration.mergeMine')}</span>
        <span>{t('collaboration.mergeServer')}</span>
      </div>
      <div className="scene-conflict-rows">
        {conflicts.map(conflict => <div key={conflictKey(conflict)} className="merge-conflict-group">
          <div className="merge-conflict-label">
            <span>{conflict.label}</span>
            <span className="merge-conflict-kind">{t(`collaboration.mergeKind.${conflict.kind}`)}</span>
          </div>
          <div className="scene-conflict-row">{side(conflict, 'local')}{side(conflict, 'server')}</div>
        </div>)}
      </div>
      <p className="match-hint">{t('collaboration.mergeHeld')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="dialog-button" disabled={busy} onClick={close}>{t('collaboration.mergeLater')}</button>
        <button className="dialog-button primary" disabled={busy} onClick={() => void apply()}>{t('collaboration.mergeApply')}</button>
      </div>
    </div>
  </div>
}
