import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../stores/projectStore'
import { getWritingHistory } from '../../stores/writingHistory'
import { flushPendingWrites } from '../../stores/pendingWrites'
import { useWritingStructureStatus } from '../../stores/writingStructure'
import { writingErrorMessage } from '../editor/writingError'

export function PlanningHistory(): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const structural = useWritingStructureStatus(state => state.busy || !!state.pending)
  const change = async (direction: 'undo' | 'redo'): Promise<void> => {
    if (busy || structural) return
    setBusy(true)
    setError(null)
    try {
      await flushPendingWrites()
      const registry = useProjectStore.getState().getWritingRegistry()
      if (!registry) return
      const result = await getWritingHistory(registry)[direction]()
      if (result.status === 'blocked' && result.reason !== 'writing.historyEmpty') setError(result.reason ?? 'writing.historyBlocked')
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  return <div className="planning-history">
    <button type="button" disabled={busy || structural} onClick={() => void change('undo')}>{t('menu.undo')}</button>
    <button type="button" disabled={busy || structural} onClick={() => void change('redo')}>{t('menu.redo')}</button>
    {error && <span role="alert">{writingErrorMessage(error)}</span>}
  </div>
}
