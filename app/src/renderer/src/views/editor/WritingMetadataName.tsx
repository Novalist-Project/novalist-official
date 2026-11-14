import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { flushPendingWrites } from '../../stores/pendingWrites'
import { useProjectStore } from '../../stores/projectStore'
import { useWorkspaceDialogGuard } from '../../shell/useWorkspaceDialogGuard'
import { contentDirection } from '../../shell/contentDirection'
import { writingErrorMessage } from './writingError'
import type { WritingContext } from './writingTypes'

export function requireWritingMetadataContext(context: WritingContext): void {
  const state = useProjectStore.getState()
  if (state.projectPath !== context.workspaceId || state.activeBookId !== context.bookId ||
      state.activeDraftId !== context.draftId || state.workspaceEpoch !== context.workspaceEpoch) {
    throw new Error('writing.structureWorkspaceChanged')
  }
}

export function WritingMetadataName({ value, label, context, save, structural = false }: {
  value: string; label: string; context: WritingContext; save(value: string): Promise<void>; structural?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const run = useWorkspaceDialogGuard(draft !== null && draft.trim() !== value, () => {
    const message = t('unifiedWriting.finishMetadataEdit')
    setError(message)
    input.current?.scrollIntoView({ block: 'center', behavior: 'instant' })
    input.current?.focus({ preventScroll: true })
    return message
  })
  const editing = draft !== null
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])
  const submit = async (): Promise<void> => {
    const next = draft?.trim()
    if (!next || busy) return
    if (next === value) { setDraft(null); return }
    setBusy(true)
    setError('')
    try {
      requireWritingMetadataContext(context)
      await flushPendingWrites()
      requireWritingMetadataContext(context)
      if (structural) await run(() => save(next))
      else await save(next)
      setDraft(null)
    } catch (reason) { setError(writingErrorMessage(reason)) }
    finally { setBusy(false) }
  }
  if (draft === null) return <button dir={contentDirection(value || label)} type="button" className="writing-metadata-name" aria-label={label}
    title={label} onClick={() => { setError(''); setDraft(value) }}>{value || label}</button>
  return <span className="writing-metadata-editor" aria-busy={busy}>
    <input dir={contentDirection(draft)} ref={input} className="writing-metadata-input" aria-label={label} value={draft} disabled={busy}
      onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submit() }
        if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); setDraft(null) }
      }} />
    <span className="writing-metadata-actions">
      <button type="button" disabled={busy || !draft.trim()} onClick={() => void submit()}>{t('dialog.save')}</button>
      <button type="button" disabled={busy} onClick={() => setDraft(null)}>{t('dialog.cancel')}</button>
    </span>
    {error && <span className="writing-metadata-error" role="alert">{error}</span>}
  </span>
}
