import { useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { rpc } from '../../rpc/client'
import { useProjectStore } from '../../stores/projectStore'
import { useWorkspaceDialogGuard } from '../../shell/useWorkspaceDialogGuard'
import { useDialogKeyboard } from '../../shell/useDialogKeyboard'
import type { PlanningStateDto } from '../../stores/planningTypes'
import type { ActRegroupPreview, StructureCommand } from '../editor/writingStructureTypes'

export function StructureRepair({ state, onCommand }: { state: PlanningStateDto; onCommand(command: StructureCommand): Promise<void> }): React.JSX.Element {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<ActRegroupPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const owner = useProjectStore.getState()
    try {
      const next = await rpc.request<ActRegroupPreview>('writing/previewRegroup', [state.bookId, state.draftId, owner.workspaceEpoch])
      const current = useProjectStore.getState()
      if (owner.projectPath === current.projectPath && owner.workspaceEpoch === current.workspaceEpoch) setPreview(next)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const apply = (): void => {
    if (!preview) return
    const command: StructureCommand = { kind: 'regroupActs', previewToken: preview.revisionToken, expectedStructureRevision: preview.revisionToken }
    flushSync(() => { setPreview(null); setBusy(true) })
    void onCommand(command).catch(reason => setError(String(reason))).finally(() => setBusy(false))
  }
  return <aside className="structure-repair">
    <p>{t('structure.repairExplanation')}</p>
    <button type="button" disabled={busy} onClick={() => void load()}>{t('structure.reviewGrouping')}</button>
    {error && <p role="alert">{error}</p>}
    {preview && <GroupingPreview state={state} preview={preview} onApply={apply} onCancel={() => setPreview(null)} />}
  </aside>
}

function GroupingPreview({ state, preview, onApply, onCancel }: {
  state: PlanningStateDto; preview: ActRegroupPreview; onApply(): void; onCancel(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  useWorkspaceDialogGuard()
  const keyboard = useDialogKeyboard(onCancel)
  const names = new Map(state.chapters.map(chapter => [chapter.guid, chapter.title]))
  return <div className="dialog-overlay"><div className="dialog-card" role="dialog" aria-modal="true" aria-label={t('structure.reviewGrouping')} {...keyboard}>
    <h2>{t('structure.reviewGrouping')}</h2>
    <div className="structure-repair-preview">{([['structure.currentOrder', preview.beforeChapterGuids], ['structure.proposedOrder', preview.afterChapterGuids]] as const)
      .map(([label, ids]) => <div key={label}><h3>{t(label)}</h3><ol>{ids.map(id => <li key={id}>{names.get(id) ?? id}</li>)}</ol></div>)}</div>
    <div className="dialog-actions"><button type="button" className="dialog-button" onClick={onCancel}>{t('dialog.cancel')}</button>
      <button type="button" className="dialog-button primary" onClick={onApply}>{t('structure.applyGrouping')}</button></div>
  </div></div>
}
